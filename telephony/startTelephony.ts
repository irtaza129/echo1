import crypto from 'crypto';
import { AudioSocketServer, type AudioSocketCall } from './sip/AudioSocketTransport.js';
import { AriController, type IncomingCall } from './sip/AriController.js';
import { CallSession } from './CallSession.js';
import { findTenantByDid } from './phoneRouting.js';
import { maskNumber } from './callRepo.js';

// Boot the phone channel.
//
// Two servers that meet in the middle:
//   • AriController talks to Asterisk, learns that a call arrived, answers it
//     and asks Asterisk to open a media leg to us.
//   • AudioSocketServer receives that media leg as a TCP connection.
//
// They are correlated by a UUID we generate and hand to Asterisk as the
// externalMedia `data` parameter, which Asterisk sends back as the first
// AudioSocket frame. Without that, two simultaneous calls could not be told
// apart — both are just inbound TCP connections from the same host.

export interface TelephonyOptions {
  ari: {
    baseUrl:  string;
    username: string;
    password: string;
    app:      string;
  };
  /** Where OUR AudioSocket listens. */
  audioSocketPort: number;
  /** host:port Asterisk should dial back to. Usually 127.0.0.1:<port>. */
  audioSocketAddress: string;
  geminiApiKey: string;
}

export interface TelephonyHandle {
  stop(): Promise<void>;
  readonly activeCalls: number;
}

export async function startTelephony(opts: TelephonyOptions): Promise<TelephonyHandle> {
  // Calls waiting for their media leg to connect, keyed by the UUID we minted.
  const pending = new Map<string, { call: IncomingCall; tenantId: string; at: number }>();
  const active  = new Set<CallSession>();

  const ari = new AriController({
    ...opts.ari,
    audioSocketAddress: opts.audioSocketAddress,
  });

  const audioSocket = new AudioSocketServer((transport: AudioSocketCall) => {
    // The first frame Asterisk sends is the UUID we gave it, which the
    // transport parses into metadata.callRef. It may not have arrived yet when
    // this fires, so wait for it rather than guessing.
    const started = Date.now();

    const tryBind = () => {
      const ref   = transport.metadata.callRef;
      const entry = ref ? pending.get(ref) : undefined;

      if (!entry) {
        // Give Asterisk a moment; the UUID frame is sent immediately but the
        // TCP connect callback can fire first.
        if (Date.now() - started < 2000) { setTimeout(tryBind, 50); return; }
        console.warn('[PHONE] media leg arrived with no matching call — dropping');
        transport.hangup();
        return;
      }

      pending.delete(ref);
      transport.metadata.from = entry.call.from;
      transport.metadata.to   = entry.call.to;

      const session = new CallSession({
        transport,
        tenantId: entry.tenantId,
        apiKey:   opts.geminiApiKey,
      });
      active.add(session);

      transport.on('close', () => { active.delete(session); });

      session.start().catch(err => {
        console.error('[PHONE] call failed to start:', err);
        // Never leave a caller on a silent line. Hang up so they hear the tone
        // and call back, rather than sitting in dead air.
        void session.end('startup failed');
        active.delete(session);
      });
    };

    tryBind();
  });

  await audioSocket.listen(opts.audioSocketPort);

  ari.on('call', (call: IncomingCall) => {
    void (async () => {
      const from = maskNumber(call.from);
      console.log(`[PHONE] inbound ${from} → ${call.to ?? 'unknown DID'}`);

      try {
        const tenantId = call.to ? await findTenantByDid(call.to) : null;
        if (!tenantId) {
          // Nobody owns this number. Hanging up is better than answering and
          // saying nothing.
          console.warn(`[PHONE] no tenant for DID ${call.to ?? '?'} — hanging up`);
          await ari.hangup(call.channelId);
          return;
        }

        await ari.answer(call.channelId);

        const uuid = crypto.randomUUID();
        pending.set(uuid, { call, tenantId, at: Date.now() });

        await ari.startExternalMedia(call.channelId, uuid);
      } catch (err) {
        console.error('[PHONE] could not set up the call:', err);
        pending.forEach((v, k) => { if (v.call.channelId === call.channelId) pending.delete(k); });
        await ari.hangup(call.channelId);
      }
    })();
  });

  ari.start();

  // Sweep calls whose media leg never arrived — an Asterisk that answered and
  // then failed to dial back would otherwise grow this map forever.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - 30_000;
    for (const [uuid, entry] of pending) {
      if (entry.at < cutoff) {
        console.warn(`[PHONE] media leg for ${uuid} never arrived — cleaning up`);
        pending.delete(uuid);
        void ari.hangup(entry.call.channelId);
      }
    }
  }, 15_000);
  sweeper.unref?.();

  console.log(`[PHONE] ready — AudioSocket on :${opts.audioSocketPort}, ARI app "${opts.ari.app}"`);

  return {
    get activeCalls() { return active.size; },
    async stop() {
      clearInterval(sweeper);
      ari.stop();
      // Drain rather than cut: hanging up on someone mid-sentence during a
      // deploy is worse than waiting a moment for them to finish.
      for (const session of active) await session.end('server shutting down');
      await audioSocket.close();
    },
  };
}
