import { GoogleGenAI, Modality, type FunctionDeclaration } from '@google/genai';

// A Gemini Live session driven from the server rather than a browser.
//
// The kiosk and the table app both connect from the client using a 60-second
// ephemeral token, because the alternative is shipping the API key to a device.
// A phone call has no browser: this process IS the client, so it uses the real
// key directly and the key never leaves the server either way.
//
// Everything about the call — the audio in, the audio out, the tool calls —
// flows through this one object so CallSession does not have to know anything
// about the SDK's shape.

export interface GeminiSessionOptions {
  apiKey: string;
  model: string;
  voice: string;
  systemInstruction: string;
  tools: FunctionDeclaration[];

  /** Agent speech, 24 kHz mono 16-bit PCM. */
  onAudio: (pcm24k: Buffer) => void;
  /** The caller started talking over the agent — drop anything queued. */
  onInterrupted: () => void;
  /** Every tool call must return a response or the turn stalls forever. */
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Text the model produced, for the transcript. */
  onText?: (role: 'agent' | 'caller', text: string) => void;
  onClose: (reason: string) => void;
  onError: (err: Error) => void;
}

interface LiveHandle {
  sendRealtimeInput(input: Record<string, unknown>): void;
  sendToolResponse(response: { functionResponses: unknown[] }): void;
  sendClientContent(content: Record<string, unknown>): void;
  close(): void;
}

export class GeminiServerSession {
  private handle: LiveHandle | null = null;
  private closed = false;

  private constructor(private readonly opts: GeminiSessionOptions) {}

  static async connect(opts: GeminiSessionOptions): Promise<GeminiServerSession> {
    const session = new GeminiServerSession(opts);
    await session.open();
    return session;
  }

  private async open(): Promise<void> {
    const { opts } = this;
    const ai = new GoogleGenAI({
      apiKey: opts.apiKey,
      httpOptions: { apiVersion: 'v1alpha' },
    });

    // Resolve only once the socket is genuinely open. Resolving on the session
    // object alone is what made the kiosk's first press silent: audio was
    // written before the WebSocket was ready and simply vanished. On a phone
    // call that would be the greeting, so the caller hears nothing at all.
    this.handle = await new Promise<LiveHandle>((resolve, reject) => {
      let opened = false;
      let pending: LiveHandle | null = null;
      const settle = () => { if (opened && pending) resolve(pending); };

      const timer = setTimeout(
        () => reject(new Error('Gemini Live did not open within 10s')),
        10_000,
      );

      void ai.live.connect({
        model: opts.model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction:  opts.systemInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } },
          },
          tools: [{ functionDeclarations: opts.tools }],
          // Transcribe both sides. The caller's words are the only record of
          // what was actually asked for when an order is disputed later.
          inputAudioTranscription:  {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen:  () => { opened = true; clearTimeout(timer); settle(); },
          onerror: (e: unknown) => {
            clearTimeout(timer);
            const err = e instanceof Error ? e : new Error(String(e));
            if (opened) opts.onError(err); else reject(err);
          },
          onclose: (e: unknown) => {
            const reason = (e as { reason?: string })?.reason ?? 'gemini closed';
            this.closed = true;
            opts.onClose(reason);
          },
          onmessage: (msg) => {
            void this.handleMessage(msg as unknown as Record<string, unknown>);
          },
        },
      }).then(h => { pending = h as unknown as LiveHandle; settle(); }, err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const sc = msg.serverContent as Record<string, unknown> | undefined;

    if (sc) {
      // Barge-in. Must be handled before anything else: every millisecond of
      // queued audio played after this is the agent talking over the caller.
      if (sc.interrupted) this.opts.onInterrupted();

      const parts = (sc.modelTurn as { parts?: Array<Record<string, unknown>> } | undefined)?.parts;
      for (const part of parts ?? []) {
        const inline = part.inlineData as { data?: string } | undefined;
        if (inline?.data) this.opts.onAudio(Buffer.from(inline.data, 'base64'));
      }

      const inTx  = sc.inputTranscription  as { text?: string } | undefined;
      const outTx = sc.outputTranscription as { text?: string } | undefined;
      if (inTx?.text)  this.opts.onText?.('caller', inTx.text);
      if (outTx?.text) this.opts.onText?.('agent',  outTx.text);
    }

    const toolCall = msg.toolCall as {
      functionCalls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }>;
    } | undefined;

    if (toolCall?.functionCalls?.length) {
      const responses = [];
      // Sequential, never Promise.all: two add_item calls in one turn would
      // otherwise race on the same cart and one item would silently vanish.
      for (const fc of toolCall.functionCalls) {
        let response: unknown;
        try {
          response = await this.opts.onToolCall(fc.name, fc.args ?? {});
        } catch (err) {
          // A failed tool still gets a response. Skipping one leaves the model
          // waiting forever, which on a phone call is dead air.
          response = { status: 'error', message: err instanceof Error ? err.message : 'failed' };
        }
        responses.push({ id: fc.id, name: fc.name, response });
      }
      this.sendToolResponse(responses);
    }
  }

  /** Caller audio in: 16 kHz mono PCM, exactly what Asterisk hands us. */
  sendAudio(pcm16k: Buffer): void {
    if (this.closed || !this.handle) return;
    try {
      this.handle.sendRealtimeInput({
        audio: { data: pcm16k.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
    } catch (err) {
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Nudge the model to speak first.
   *
   * On every other channel the agent waits for the customer. On a phone the
   * caller is waiting for US — silence after "connected" reads as a dead line
   * and people hang up. This sends a turn with no user text, which the system
   * instruction tells it to answer with the greeting.
   */
  greet(): void {
    if (this.closed || !this.handle) return;
    try {
      this.handle.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: '<call connected>' }] }],
        turnComplete: true,
      });
    } catch (err) {
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private sendToolResponse(functionResponses: unknown[]): void {
    if (this.closed || !this.handle) return;
    try {
      this.handle.sendToolResponse({ functionResponses });
    } catch (err) {
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.handle?.close(); } catch { /* already gone */ }
    this.handle = null;
  }
}
