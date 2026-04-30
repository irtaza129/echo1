export function base64ToInt16Array(base64: string): Int16Array {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export function int16ToFloat32(int16Array: Int16Array): Float32Array {
  const float32 = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32[i] = int16Array[i] / 32768.0;
  }
  return float32;
}

export function float32ToInt16Base64(float32Array: Float32Array): string {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16Array.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

export class AudioPlayer {
  ctx: AudioContext | null = null;
  queue: AudioBufferSourceNode[] = [];
  nextTime = 0;
  onQueueEmpty: (() => void) | null = null; // add this property

  init() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 24000 });
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playPCM(base64: string, sampleRate = 24000) {
    this.init();
    if (!this.ctx) return;
    
    const int16 = base64ToInt16Array(base64);
    const float32 = int16ToFloat32(int16);
    const buffer = this.ctx.createBuffer(1, float32.length, sampleRate);
    buffer.getChannelData(0).set(float32);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    
    if (this.nextTime < this.ctx.currentTime) {
      this.nextTime = this.ctx.currentTime;
    }
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
    this.queue.push(source);
    
    source.onended = () => {
      this.queue = this.queue.filter(s => s !== source);
      if (this.queue.length === 0 && this.onQueueEmpty) {
        this.onQueueEmpty(); // fire when last chunk finishes playing
      }
    };
  }

  stop() {
    this.queue.forEach(s => {
      try {
        s.stop();
      } catch (e) {}
    });
    this.queue = [];
    this.nextTime = 0;
    if (this.onQueueEmpty) this.onQueueEmpty(); // fire immediately on manual stop
  }
}

export class AudioRecorder {
  ctx: AudioContext | null = null;
  stream: MediaStream | null = null;
  source: MediaStreamAudioSourceNode | null = null;
  processor: ScriptProcessorNode | null = null;
  gain: GainNode | null = null;
  onData: ((base64: string) => void) | null = null;
  
  init() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: 16000 });
    }
  }

  async start(onData: (base64: string) => void) {
    this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.onData = onData;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Only set up nodes if we haven't already
    if (!this.processor) {
      this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
      
      this.processor.onaudioprocess = (e) => {
        if (!this.onData) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const base64 = float32ToInt16Base64(inputData);
        this.onData(base64);
      };
      
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      
      this.processor.connect(this.gain);
      this.gain.connect(this.ctx.destination);
    }

    this.source?.disconnect();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.processor);
  }

  stop() {
    this.onData = null;
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
  }

  destroy() {
    this.stop();
    this.processor?.disconnect();
    this.processor = null;
    this.gain?.disconnect();
    this.gain = null;
    this.ctx?.close();
    this.ctx = null;
  }
}
