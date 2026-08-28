import crypto from 'crypto';
import type { CallTransport } from './sip/CallTransport.js';
import { pcm24kTo16k } from './sip/resample.js';
import { GeminiServerSession } from './GeminiServerSession.js';
import { phoneTools } from './phoneTools.js';
import { PromptBuilder } from '../src/lib/PromptBuilder.js';
import { parseTenantConfig, type TenantConfig } from '../src/lib/tenantConfig.js';
import { getRedis, redisKey } from '../src/lib/redis.js';
import { AdapterFactory } from '../adapter/AdapterFactory.js';
import { publish } from '../src/lib/posEvents.js';
import { callsRepo, type CallOutcome } from './callRepo.js';
import {
  resolveItemLocal, removeItemLocal, clearCartLocal, submitOrderLocal,
} from './toolDispatch.js';

// One phone call, from answer to hang-up.
//
// Sits between a CallTransport (which knows nothing about ordering) and a
// Gemini Live session (which knows nothing about telephony), and owns the two
// things neither of them can: the audio direction change, and what the tools
// actually do.
//
// Deliberately takes a CallTransport rather than an AudioSocket: this class is
// the part worth testing, and a fake transport lets it be tested with no
// Asterisk, no trunk and no phone.

export interface CallSessionOptions {
  transport: CallTransport;
  tenantId:  string;
  apiKey:    string;
  /** Hard ceiling so a wedged call cannot bill trunk minutes forever. */
  maxSeconds?: number;
}

interface TranscriptTurn { role: 'agent' | 'caller'; text: string; at: string }

export class CallSession {
  private readonly sessionId = crypto.randomUUID();
  private gemini: GeminiServerSession | null = null;
  private config: TenantConfig | null = null;
  private callRowId: string | null = null;

  private readonly transcript: TranscriptTurn[] = [];
  private orderType: string = 'pickup';
  private address:   string | null = null;
  private orderId:   string | null = null;
  private outcome:   CallOutcome = 'in_progress';
  private ended = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: CallSessionOptions) {}

  async start(): Promise<void> {
    const { transport, tenantId, apiKey } = this.opts;

    this.config = await loadConfig(tenantId);
    const phone = this.config.channels?.phone;

    this.callRowId = await callsRepo.start({
      tenantId,
      fromNumber: transport.metadata.from ?? null,
      toDid:      transport.metadata.to   ?? null,
      channelRef: transport.metadata.callRef || null,
    }).catch(err => {
      // A call record that cannot be written is a reporting loss, not a reason
      // to drop a paying customer's call.
      console.error('[CALL] could not open call record:', err);
      return null;
    });

    const adapter     = AdapterFactory.create(this.config, {});
    const menuContext = await adapter.getMenuContext().catch(() => '');

    const systemInstruction = PromptBuilder.build({
      restaurantName: this.config.restaurantName,
      gemini:         this.config.gemini,
      businessRules:  { gstRate: this.config.businessRules.gstRate },
      channel:        'phone',
      canTransferToHuman: Boolean(phone?.transferTo),
      // A phone order is paid in cash on collection or at the door. Card would
      // mean reading numbers out over a line, which nobody should build.
      acceptsCard:    false,
    }, menuContext);

    this.gemini = await GeminiServerSession.connect({
      apiKey,
      model: this.config.gemini.modelOverride ?? 'gemini-3.1-flash-live-preview',
      voice: this.config.gemini.voice,
      systemInstruction,
      tools: phoneTools({ canTransfer: Boolean(phone?.transferTo) }),

      onAudio: (pcm24k) => {
        // The one conversion in the whole bridge. Asterisk hands us 16 kHz and
        // Gemini wants 16 kHz, so inbound needs nothing; outbound is 24 → 16.
        transport.write(pcm24kTo16k(pcm24k));
      },

      onInterrupted: () => {
        // The caller talked over the agent. Everything already queued is audio
        // they have decided they do not want to hear.
        transport.flush();
      },

      onToolCall: (name, args) => this.runTool(name, args),

      onText: (role, text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        // Live transcription arrives in fragments; append to the current turn
        // rather than making one entry per syllable.
        const last = this.transcript[this.transcript.length - 1];
        if (last && last.role === role) last.text += trimmed;
        else this.transcript.push({ role, text: trimmed, at: new Date().toISOString() });
      },

      onClose: (reason) => { void this.end(reason); },
      onError: (err)    => { console.error(`[CALL] ${this.sessionId} gemini error:`, err.message); },
    });

    transport.onAudio((pcm16k) => this.gemini?.sendAudio(pcm16k));
    transport.onClose((reason) => { void this.end(reason); });

    // A call that wedges — a model stuck in a loop, a caller who put the phone
    // down without hanging up — would otherwise bill trunk minutes indefinitely.
    const maxSeconds = this.opts.maxSeconds ?? phone?.maxCallSeconds ?? 600;
    this.timeout = setTimeout(() => {
      console.warn(`[CALL] ${this.sessionId} hit the ${maxSeconds}s ceiling — ending`);
      void this.end('max duration reached');
    }, maxSeconds * 1000);

    // Speak first. On every other channel the agent waits; on a phone, silence
    // reads as a dead line.
    this.gemini.greet();
    await callsRepo.markAnswered(this.callRowId).catch(() => undefined);
  }

  // ── Tools ──────────────────────────────────────────────────────────────────

  private async runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tenantId = this.opts.tenantId;

    switch (name) {
      case 'set_order_type': {
        const t = String(args.order_type ?? '').toLowerCase();
        // Normalised here rather than trusted: the DB has a CHECK constraint on
        // order_type and an unrecognised value would fail at submit, several
        // minutes into the call.
        this.orderType = ['delivery', 'pickup', 'takeaway'].includes(t) ? t : 'pickup';
        if (this.outcome === 'in_progress') this.outcome = 'ordered';
        return { status: 'ok', order_type: this.orderType };
      }

      case 'capture_address': {
        const addr = String(args.address ?? '').trim();
        if (!addr) return { status: 'error', message: 'No address was given' };
        this.address = args.landmark ? `${addr} (near ${String(args.landmark)})` : addr;
        return { status: 'ok', address: this.address };
      }

      case 'check_hours': {
        // Hours are not modelled yet, so say so rather than inventing them —
        // an agent that guesses opening times sends people to a closed door.
        return {
          status: 'ok',
          message: 'I do not have the exact timings to hand — please check with the restaurant directly.',
        };
      }

      case 'transfer_to_human': {
        this.outcome = 'transferred';
        const to = this.config?.channels?.phone?.transferTo;
        // The bridge itself is an Asterisk operation and lives in AriController;
        // here we record intent and end our leg.
        console.log(`[CALL] ${this.sessionId} transfer requested → ${to ?? 'nobody'}: ${String(args.reason ?? '')}`);
        setTimeout(() => void this.end('transferred to human'), 1500);
        return { status: 'ok', message: 'Putting you through now, one moment.' };
      }

      case 'end_call': {
        // Let the goodbye finish playing before the line drops.
        setTimeout(() => void this.end('agent ended the call'), 2000);
        return { status: 'ok' };
      }

      case 'add_item':
        return resolveItemLocal(tenantId, this.sessionId, {
          dish_query: String(args.dish_query ?? ''),
          modifiers:  Array.isArray(args.modifiers) ? args.modifiers.map(String) : undefined,
          quantity:   typeof args.quantity === 'number' ? args.quantity : undefined,
          notes:      args.notes ? String(args.notes) : null,
        });

      case 'remove_item':
        await removeItemLocal(tenantId, this.sessionId, String(args.cart_item_id ?? ''));
        return { status: 'ok' };

      case 'clear_cart':
        await clearCartLocal(tenantId, this.sessionId);
        return { status: 'ok' };

      case 'confirm_order': {
        if (this.orderType === 'delivery' && !this.address) {
          // Refusing here is the point: a delivery order with no address is an
          // order nobody can fulfil, and the moment to catch it is while the
          // caller is still on the line.
          return {
            status: 'requires_input',
            message: 'Before I place this, I need the delivery address. Please ask the caller for it.',
          };
        }

        try {
          const result = await submitOrderLocal(
            tenantId, this.sessionId,
            {
              customer_name:  args.customer_name  ? String(args.customer_name)  : 'Phone order',
              // Fall back to the caller ID only if they did not say a number.
              // Pakistani trunks do not reliably deliver CLI, which is why the
              // prompt tells the agent to ask rather than assume.
              customer_phone: args.customer_phone
                ? String(args.customer_phone)
                : this.opts.transport.metadata.from ?? '',
              order_type:     this.orderType,
              notes:          this.address ? `Deliver to: ${this.address}` : null,
            },
            this.config!,
            'phone',
          );

          this.orderId = result.order_id;
          this.outcome = 'ordered';

          publish(tenantId, 'order.created', {
            orderId: result.order_id, orderNumber: result.order_number,
            orderType: this.orderType, total: result.total, source: 'phone',
          });

          return {
            status: 'ok',
            message: `Order number ${result.order_number} is confirmed. The total is ${result.total}.`,
          };
        } catch (err) {
          return {
            status: 'error',
            message: err instanceof Error ? err.message : 'The order could not be placed',
          };
        }
      }

      default:
        return { status: 'error', message: `Unknown tool ${name}` };
    }
  }

  // ── Teardown ───────────────────────────────────────────────────────────────

  async end(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;

    if (this.timeout) { clearTimeout(this.timeout); this.timeout = null; }

    this.gemini?.close();
    this.gemini = null;
    try { this.opts.transport.hangup(); } catch { /* already gone */ }

    // A caller who hung up without ordering is abandoned, not failed — the
    // distinction is the difference between "people browse" and "it is broken".
    if (this.outcome === 'in_progress') {
      this.outcome = this.transcript.length > 0 ? 'enquiry' : 'abandoned';
    }

    // The cart is scoped to this call and has a TTL, but leaving it means a
    // retried call could inherit half an order.
    await clearCartLocal(this.opts.tenantId, this.sessionId).catch(() => undefined);

    await callsRepo.finish(this.callRowId, {
      outcome:    this.outcome,
      orderId:    this.orderId,
      transcript: this.transcript,
    }).catch(err => console.error('[CALL] could not close call record:', err));

    console.log(`[CALL] ${this.sessionId} ended (${reason}) outcome=${this.outcome}`);
  }
}


async function loadConfig(tenantId: string): Promise<TenantConfig> {
  const cached = await getRedis().get<unknown>(redisKey.tenantConfig(tenantId));
  if (!cached) throw new Error(`[CALL] no config for tenant ${tenantId}`);
  return parseTenantConfig(cached);
}
