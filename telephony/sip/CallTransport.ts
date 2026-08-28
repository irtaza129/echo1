// What a call looks like to the rest of the system.
//
// Deliberately narrow: audio in, audio out, hang up. Everything above this
// interface — the Gemini bridge, the tool dispatch, the prompt — is unaware of
// whether the call arrived over a SIP trunk, a Twilio Media Stream or a test
// harness feeding it a wav file.
//
// That matters more here than usual. Telephony is the one part of this system
// that cannot be exercised without infrastructure: a trunk, a static IP, an
// Asterisk box. Putting a seam here means CallSession is testable against a
// fake transport with no infrastructure at all, and swapping provider later is
// a new file rather than a rewrite.

export interface CallMetadata {
  /** Provider's own id for the call — Asterisk channel id, Twilio CallSid. */
  callRef: string;
  /** Caller's number in E.164 where the trunk supplies it. */
  from?:   string;
  /** The number that was dialled — this is what maps the call to a tenant. */
  to?:     string;
}

export interface CallTransport {
  readonly metadata: CallMetadata;

  /**
   * Inbound caller audio: 16 kHz mono signed 16-bit little-endian PCM.
   *
   * Fixed at 16 kHz because that is what Gemini Live wants and what Asterisk
   * hands us when the external media channel is created as `slin16` — so the
   * inbound path needs no conversion at all.
   */
  onAudio(cb: (pcm16k: Buffer) => void): void;

  /** Called when the far end goes away, for any reason. */
  onClose(cb: (reason: string) => void): void;

  /**
   * Queue agent audio for the caller: 16 kHz mono PCM.
   *
   * Implementations MUST pace this at real time (20 ms per frame). Writing
   * faster does not make it play faster — it makes the far end buffer it, and
   * buffered audio cannot be dropped when the caller interrupts.
   */
  write(pcm16k: Buffer): void;

  /**
   * Discard everything queued but not yet sent.
   *
   * This is what makes barge-in work. Without it, the caller interrupts, we
   * stop generating immediately — and the agent still talks over them for
   * however many seconds are already sitting in the queue.
   */
  flush(): void;

  hangup(): void;

  /** Frames queued but not yet written. Used by tests and for backpressure logs. */
  readonly queued: number;
}
