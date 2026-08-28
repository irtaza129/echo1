// The AudioSocket transport, driven by a fake Asterisk over a real TCP socket.
//
//   npx tsx testing/test-telephony-transport.ts
//
// No Asterisk, no SIP trunk, no phone. This is the point of putting a
// CallTransport seam in: the pacing, the barge-in flush, the queue cap and the
// teardown are all exercisable on a laptop, and those are exactly the things
// that are miserable to debug on a live call.

import assert from 'node:assert';
import net from 'net';
import { AudioSocketServer, type AudioSocketCall } from '../telephony/sip/AudioSocketTransport.js';
import { FRAME, FrameParser, encodeFrame, bytesPerFrame } from '../telephony/sip/audiosocket.js';

let passed = 0, failed = 0;
const section = (n: string) => console.log(n);
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const FRAME_BYTES = bytesPerFrame(16000);   // 640

/** Stands in for Asterisk: connects, sends the UUID, then speaks and listens. */
class FakeAsterisk {
  readonly received: Buffer[] = [];
  private readonly parser = new FrameParser();
  private socket!: net.Socket;

  async connect(port: number, uuidHex: string): Promise<void> {
    this.socket = net.createConnection({ port, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      this.socket.once('connect', () => resolve());
      this.socket.once('error', reject);
    });
    this.socket.on('data', chunk => {
      for (const f of this.parser.push(chunk)) {
        if (f.type === FRAME.AUDIO) this.received.push(f.payload);
        if (f.type === FRAME.TERMINATE) this.terminated = true;
      }
    });
    this.socket.write(encodeFrame(FRAME.UUID, Buffer.from(uuidHex, 'hex')));
  }

  terminated = false;

  /** Caller speaking. */
  speak(pcm: Buffer): void { this.socket.write(encodeFrame(FRAME.AUDIO, pcm)); }

  hangup(): void { this.socket.write(encodeFrame(FRAME.TERMINATE)); }
  destroy(): void { this.socket.destroy(); }

  /** Frames that are not pure silence — i.e. actual agent speech. */
  get audible(): Buffer[] {
    return this.received.filter(b => b.some(byte => byte !== 0));
  }
}

let server: AudioSocketServer | null = null;
let port = 0;
let current: AudioSocketCall | null = null;

server = new AudioSocketServer(call => { current = call; });
await server.listen(0, '127.0.0.1');
port = server.port!;

const UUID = '0123456789abcdef0123456789abcdef';

section('AudioSocket transport');

await check('a connection becomes a call and picks up the UUID', async () => {
  const ast = new FakeAsterisk();
  await ast.connect(port, UUID);
  await sleep(80);

  assert.ok(current, 'the server should hand us a transport');
  assert.equal(current!.metadata.callRef, '01234567-89ab-cdef-0123-456789abcdef',
    'the call ref comes from the UUID frame, which is what correlates the media leg');
  ast.destroy();
  await sleep(50);
});

await check('caller audio reaches onAudio as raw PCM', async () => {
  const ast = new FakeAsterisk();
  await ast.connect(port, UUID);
  await sleep(50);

  const heard: Buffer[] = [];
  current!.onAudio(pcm => heard.push(pcm));

  ast.speak(Buffer.alloc(FRAME_BYTES, 3));
  ast.speak(Buffer.alloc(FRAME_BYTES, 4));
  await sleep(100);

  assert.equal(heard.length, 2);
  assert.equal(heard[0].length, FRAME_BYTES);
  assert.equal(heard[0][0], 3);
  ast.destroy();
  await sleep(50);
});

await check('agent audio is paced at 20 ms, not dumped', async () => {
  // Dumping is the bug that breaks barge-in: audio written faster than real
  // time sits in a buffer downstream where it can no longer be dropped.
  const ast = new FakeAsterisk();
  await ast.connect(port, UUID);
  await sleep(50);

  // One second of speech.
  current!.write(Buffer.alloc(FRAME_BYTES * 50, 9));

  await sleep(200);
  const after200 = ast.audible.length;
  assert.ok(after200 >= 5 && after200 <= 16,
    `~10 frames expected in 200ms, got ${after200} — pacing is wrong`);
  assert.ok(after200 < 50, 'the whole second must NOT arrive at once');

  ast.destroy();
  await sleep(50);
});

await check('silence is sent when there is nothing to say', async () => {
  // Asterisk treats a gap on an external media channel as the media having
  // stopped, so the stream has to be continuous.
  const ast = new FakeAsterisk();
  await ast.connect(port, UUID);
  await sleep(200);

  assert.ok(ast.received.length >= 5, `expected a steady stream, got ${ast.received.length}`);
  assert.equal(ast.audible.length, 0, 'and all of it silent while the agent says nothing');
  ast.destroy();
  await sleep(50);
});

await check('flush() drops queued audio — this is barge-in', async () => {
  const ast = new FakeAsterisk();
  await ast.connect(port, UUID);
  await sleep(50);

  current!.write(Buffer.alloc(FRAME_BYTES * 50, 7));   // one second queued
  assert.ok(current!.queued > 40, 'the queue should be full');

  current!.flush();
  assert.equal(current!.queued, 0, 'flush must empty the queue immediately');

  const before = ast.audible.length;
  await sleep(200);
  assert.ok(ast.audible.length - before <= 1,
    'almost nothing should play after a flush — the caller interrupted');

  ast.destroy();
  await sleep(50);
});

await check('the output queue is capped so it cannot run away', async () => {
  const ast = new FakeAsterisk();
  await ast.connect(port, UUID);
  await sleep(50);

  // Ten seconds of audio at once. Anything beyond the cap is dropped rather
  // than left to drift further and further behind real time.
  current!.write(Buffer.alloc(FRAME_BYTES * 500, 1));
  assert.ok(current!.queued <= 250, `queue should be capped, got ${current!.queued}`);

  ast.destroy();
  await sleep(50);
});

await check('a caller hangup closes the call with a reason', async () => {
  const ast = new FakeAsterisk();
  await ast.connect(port, UUID);
  await sleep(50);

  let reason = '';
  current!.onClose(r => { reason = r; });

  ast.hangup();
  await sleep(120);

  assert.match(reason, /hung up/i, `expected a hangup reason, got "${reason}"`);
  ast.destroy();
  await sleep(50);
});

await check('a dropped socket closes the call too', async () => {
  const ast = new FakeAsterisk();
  await ast.connect(port, UUID);
  await sleep(50);

  let closed = false;
  current!.onClose(() => { closed = true; });

  ast.destroy();          // rude disconnect, no TERMINATE
  await sleep(150);

  assert.equal(closed, true, 'a vanished socket must still end the call');
});

await check('hangup() tells the far end and stops the pacer', async () => {
  const ast = new FakeAsterisk();
  await ast.connect(port, UUID);
  await sleep(50);

  current!.hangup();
  await sleep(150);

  assert.equal(ast.terminated, true, 'the far end should receive a TERMINATE frame');

  const settled = ast.received.length;
  await sleep(200);
  assert.equal(ast.received.length, settled, 'nothing more should be sent after hangup');
  ast.destroy();
});

await check('writing after close is a no-op, not a crash', async () => {
  const ast = new FakeAsterisk();
  await ast.connect(port, UUID);
  await sleep(50);
  const call = current!;

  ast.destroy();
  await sleep(120);

  // Gemini can deliver a final audio chunk after the caller has already gone.
  assert.doesNotThrow(() => call.write(Buffer.alloc(FRAME_BYTES, 1)));
  assert.doesNotThrow(() => call.flush());
  assert.doesNotThrow(() => call.hangup());
});

await check('two simultaneous calls stay independent', async () => {
  const calls: AudioSocketCall[] = [];
  const srv = new AudioSocketServer(c => calls.push(c));
  await srv.listen(0, '127.0.0.1');

  const a = new FakeAsterisk();
  const b = new FakeAsterisk();
  await a.connect(srv.port!, '11111111111111111111111111111111');
  await b.connect(srv.port!, '22222222222222222222222222222222');
  await sleep(120);

  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].metadata.callRef, calls[1].metadata.callRef,
    'each call must be distinguishable — they are otherwise just TCP connections');

  const heardA: Buffer[] = [];
  calls[0].onAudio(p => heardA.push(p));
  b.speak(Buffer.alloc(FRAME_BYTES, 5));
  await sleep(100);
  assert.equal(heardA.length, 0, "one call must not receive another's audio");

  a.destroy(); b.destroy();
  await sleep(80);
  await srv.close();
});

await server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
