/**
 * Web Audio output for ZX Spectrum beeper + AY chip.
 *
 * Primary path: AudioWorklet with a SharedArrayBuffer ring buffer —
 * the emulation thread writes samples, the audio thread reads them
 * with zero copying. Requires Cross-Origin-Isolation headers.
 *
 * Fallback: ScriptProcessorNode (deprecated but universally supported).
 *
 * Both paths share a single AudioRing implementation. The only difference
 * is the backing buffer (SharedArrayBuffer vs ArrayBuffer); Atomics works
 * on both so the writer code is identical.
 */

const RING_SIZE = 8192;
const RING_MASK = RING_SIZE - 1;

interface AudioRing {
  l: Float32Array;
  r: Float32Array;
  pos: Int32Array;            // [0] = writePos, [1] = readPos
  buffer: ArrayBuffer | SharedArrayBuffer;
}

function makeRing(shared: boolean): AudioRing {
  const byteLength = RING_SIZE * 8 + 8;
  const buffer: ArrayBuffer | SharedArrayBuffer = shared
    ? new SharedArrayBuffer(byteLength)
    : new ArrayBuffer(byteLength);
  return {
    buffer,
    l: new Float32Array(buffer, 0, RING_SIZE),
    r: new Float32Array(buffer, RING_SIZE * 4, RING_SIZE),
    pos: new Int32Array(buffer, RING_SIZE * 8, 2),
  };
}

function ringWrite(ring: AudioRing, l: number, r: number): boolean {
  const wp = Atomics.load(ring.pos, 0);
  const next = (wp + 1) & RING_MASK;
  if (next === Atomics.load(ring.pos, 1)) return false; // full
  ring.l[wp] = l;
  ring.r[wp] = r;
  Atomics.store(ring.pos, 0, next);
  return true;
}

function ringBuffered(ring: AudioRing): number {
  return (Atomics.load(ring.pos, 0) - Atomics.load(ring.pos, 1) + RING_SIZE) & RING_MASK;
}

function ringReset(ring: AudioRing): void {
  Atomics.store(ring.pos, 0, 0);
  Atomics.store(ring.pos, 1, 0);
  ring.l.fill(0);
  ring.r.fill(0);
}

/** Inlined AudioWorklet processor (avoids a separate JS file). */
const WORKLET_SOURCE = `
class SpectrumProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.ringL = new Float32Array(o.buf, 0, o.size);
    this.ringR = new Float32Array(o.buf, o.size * 4, o.size);
    this.pos = new Int32Array(o.buf, o.size * 8, 2);
    this.mask = o.size - 1;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const outL = out[0];
    const outR = out[1] || outL;
    let rp = Atomics.load(this.pos, 1);
    const wp = Atomics.load(this.pos, 0);
    for (let i = 0; i < outL.length; i++) {
      if (rp !== wp) {
        outL[i] = this.ringL[rp];
        outR[i] = this.ringR[rp];
        rp = (rp + 1) & this.mask;
      } else {
        outL[i] = 0;
        outR[i] = 0;
      }
    }
    Atomics.store(this.pos, 1, rp);
    return true;
  }
}
registerProcessor('spectrum-audio', SpectrumProcessor);
`;

export class Audio {
  ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;

  private workletNode: AudioWorkletNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private ring: AudioRing | null = null;

  /** Volume set before init() — applied at the end of init(). */
  private pendingVolume = 0.7;

  // Default to 48 kHz — the platform default on Windows and most modern
  // DACs. Overwritten by init() with the AudioContext's actual rate.
  // (Avoid 44.1 kHz: AY tones come out subtly mistuned if we lie to consumers
  // about the rate before the context exists.)
  sampleRate = 48000;
  running = false;

  /**
   * Initialize audio context and output node.
   * Tries AudioWorklet + SharedArrayBuffer first; falls back to
   * ScriptProcessorNode if unavailable.
   */
  async init(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }

    // Let the platform pick the sample rate (don't force 44.1 kHz — the
    // platform default is usually 48 kHz on Windows / many DACs and forcing
    // a non-native rate adds a hidden resampler stage).
    this.ctx = new AudioContext();
    this.sampleRate = this.ctx.sampleRate;

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this.pendingVolume;

    if (typeof SharedArrayBuffer !== 'undefined' && this.ctx.audioWorklet) {
      try {
        const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await this.ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        this.ring = makeRing(true);
        this.workletNode = new AudioWorkletNode(this.ctx, 'spectrum-audio', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { buf: this.ring.buffer, size: RING_SIZE },
        });
        this.workletNode.connect(this.gainNode);
      } catch {
        // Drop any SAB we may have allocated so the fallback path doesn't leak it.
        this.ring = null;
        this.initScriptProcessor();
      }
    } else {
      this.initScriptProcessor();
    }

    this.gainNode.connect(this.ctx.destination);
    this.running = true;
  }

  private initScriptProcessor(): void {
    if (!this.ctx || !this.gainNode) return;
    this.ring = makeRing(false);
    this.processor = this.ctx.createScriptProcessor(4096, 0, 2);
    this.processor.onaudioprocess = (e) => this.audioCallback(e);
    this.processor.connect(this.gainNode);
  }

  private audioCallback(e: AudioProcessingEvent): void {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    const ring = this.ring;
    if (!ring) {
      outL.fill(0);
      outR.fill(0);
      return;
    }
    let rp = Atomics.load(ring.pos, 1);
    const wp = Atomics.load(ring.pos, 0);
    for (let i = 0; i < outL.length; i++) {
      if (rp !== wp) {
        outL[i] = ring.l[rp];
        outR[i] = ring.r[rp];
        rp = (rp + 1) & RING_MASK;
      } else {
        outL[i] = 0;
        outR[i] = 0;
      }
    }
    Atomics.store(ring.pos, 1, rp);
  }

  pushSample(left: number, right: number): void {
    if (!this.ring) return;
    ringWrite(this.ring, left, right);
  }

  bufferedSamples(): number {
    if (!this.ring) return 0;
    return ringBuffered(this.ring);
  }

  setVolume(v: number): void {
    if (!Number.isFinite(v)) return;       // ignore NaN / ±Infinity
    const clamped = Math.max(0, Math.min(1, v));
    this.pendingVolume = clamped;
    if (this.gainNode) this.gainNode.gain.value = clamped;
  }

  reset(): void {
    if (this.ring) ringReset(this.ring);
  }

  destroy(): void {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.ctx) {
      // close() returns a promise; fire-and-forget but swallow rejection so
      // we don't leak an unhandled-rejection. The context is already detached.
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.ring = null;
    this.running = false;
  }
}
