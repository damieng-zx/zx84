/**
 * audio.ts — Web Audio output ring buffer.
 *
 * audio.ts has two delivery paths driven by the same public API:
 *  1. AudioWorklet + SharedArrayBuffer (preferred, lock-free)
 *  2. ScriptProcessorNode (fallback, main-thread ring)
 *
 * Both paths now share a single AudioRing implementation; the only
 * difference is whether the backing buffer is SAB or regular. These tests
 * pin:
 *   - pushSample drops when the ring is full (capacity = RING_SIZE − 1)
 *   - bufferedSamples reports the right count across wraparound
 *   - reset zeros the head/tail and the ring itself
 *   - destroy() leaves the object safe to GC and to re-init
 *   - setVolume guards against NaN and remembers pre-init values
 *   - pushSample / bufferedSamples after destroy do not crash
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const RING_SIZE = 8192;

// ─────────────────────────────────────────────────────────────────────────
// Web Audio mocks
// ─────────────────────────────────────────────────────────────────────────

class MockGainParam {
  value = 1;
  setValueAtTime(v: number) { this.value = v; }
}

class MockGain {
  gain = new MockGainParam();
  connected: unknown[] = [];
  disconnectCount = 0;
  connect(n: unknown) { this.connected.push(n); return n; }
  disconnect() { this.disconnectCount++; }
}

class MockScriptProcessor {
  onaudioprocess: ((e: AudioProcessingEvent) => void) | null = null;
  connectedTo: unknown[] = [];
  disconnectCount = 0;
  constructor(public bufferSize: number, public ins: number, public outs: number) {}
  connect(n: unknown) { this.connectedTo.push(n); return n; }
  disconnect() { this.disconnectCount++; }
}

class MockWorkletNode {
  static lastOptions: any = null;
  connectedTo: unknown[] = [];
  disconnectCount = 0;
  constructor(public ctx: MockCtx, public name: string, options: any) {
    MockWorkletNode.lastOptions = options;
  }
  connect(n: unknown) { this.connectedTo.push(n); return n; }
  disconnect() { this.disconnectCount++; }
}

class MockWorklet {
  addedModules: string[] = [];
  shouldFail = false;
  async addModule(url: string): Promise<void> {
    if (this.shouldFail) throw new Error('addModule failed');
    this.addedModules.push(url);
  }
}

class MockCtx {
  state: 'running' | 'suspended' | 'closed' = 'running';
  sampleRate = 44100;
  destination = {};
  audioWorklet: MockWorklet | null = new MockWorklet();
  closeCount = 0;
  resumeCount = 0;
  scriptProcessors: MockScriptProcessor[] = [];
  gains: MockGain[] = [];
  constructor(opts?: { sampleRate?: number }) {
    if (opts?.sampleRate) this.sampleRate = opts.sampleRate;
  }
  createGain() { const g = new MockGain(); this.gains.push(g); return g; }
  createScriptProcessor(size: number, ins: number, outs: number) {
    const p = new MockScriptProcessor(size, ins, outs);
    this.scriptProcessors.push(p);
    return p;
  }
  async resume() { this.resumeCount++; this.state = 'running'; }
  async close() { this.closeCount++; this.state = 'closed'; }
}

let currentCtx: MockCtx | null = null;
let workletNodeShouldThrow = false;
let sabAvailable = true;

function installGlobals(): void {
  (globalThis as any).AudioContext = function (opts?: any) {
    currentCtx = new MockCtx(opts);
    return currentCtx;
  } as any;
  (globalThis as any).AudioWorkletNode = function (ctx: any, name: string, opts: any) {
    if (workletNodeShouldThrow) throw new Error('worklet node construction failed');
    return new MockWorkletNode(ctx, name, opts);
  } as any;
  if (!sabAvailable) (globalThis as any).SharedArrayBuffer = undefined;
}

function uninstallGlobals(): void {
  delete (globalThis as any).AudioContext;
  delete (globalThis as any).AudioWorkletNode;
}

const realCreate = (URL as any).createObjectURL;
const realRevoke = (URL as any).revokeObjectURL;

beforeEach(() => {
  currentCtx = null;
  workletNodeShouldThrow = false;
  sabAvailable = true;
  (URL as any).createObjectURL = () => 'blob:fake';
  (URL as any).revokeObjectURL = () => {};
  MockWorkletNode.lastOptions = null;
  installGlobals();
});

afterEach(() => {
  uninstallGlobals();
  (URL as any).createObjectURL = realCreate;
  (URL as any).revokeObjectURL = realRevoke;
  if ((globalThis as any).__sabBackup) {
    (globalThis as any).SharedArrayBuffer = (globalThis as any).__sabBackup;
    delete (globalThis as any).__sabBackup;
  }
});

async function freshAudio() {
  const mod = await import('@/audio.ts');
  return new mod.Audio();
}

// Helper: get the internal ring object — both paths use the same field now.
function ring(a: any): { l: Float32Array; r: Float32Array; pos: Int32Array; buffer: ArrayBuffer | SharedArrayBuffer } {
  return a.ring;
}

// ─────────────────────────────────────────────────────────────────────────
// Initialisation
// ─────────────────────────────────────────────────────────────────────────

describe('Audio.init — worklet path', () => {
  it('creates a context, gain, worklet node, and SAB-backed ring', async () => {
    const a = await freshAudio();
    await a.init();
    expect(a.ctx).not.toBeNull();
    expect(a.running).toBe(true);
    expect((a as any).workletNode).not.toBeNull();
    const r = ring(a);
    expect(r.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(r.l).toBeInstanceOf(Float32Array);
    expect(r.r).toBeInstanceOf(Float32Array);
    expect(r.pos).toBeInstanceOf(Int32Array);
  });

  it('shared buffer is sized for stereo Float32 ring + 2× Int32 head/tail', async () => {
    const a = await freshAudio();
    await a.init();
    expect(ring(a).buffer.byteLength).toBe(RING_SIZE * 8 + 8);
  });

  it('passes the SAB and ring size into the worklet processor', async () => {
    const a = await freshAudio();
    await a.init();
    expect(MockWorkletNode.lastOptions.processorOptions.size).toBe(RING_SIZE);
    expect(MockWorkletNode.lastOptions.processorOptions.buf).toBe(ring(a).buffer);
    expect(MockWorkletNode.lastOptions.outputChannelCount).toEqual([2]);
  });

  it('falls back to ScriptProcessorNode if AudioWorkletNode construction throws', async () => {
    workletNodeShouldThrow = true;
    const a = await freshAudio();
    await a.init();
    expect((a as any).workletNode).toBeNull();
    expect((a as any).processor).not.toBeNull();
    expect(currentCtx!.scriptProcessors.length).toBe(1);
  });

  it('the fallback ring is NOT SAB-backed (no leaked shared memory)', async () => {
    workletNodeShouldThrow = true;
    const a = await freshAudio();
    await a.init();
    expect(ring(a).buffer).not.toBeInstanceOf(SharedArrayBuffer);
    expect(ring(a).buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('falls back to ScriptProcessorNode if addModule rejects', async () => {
    const a = await freshAudio();
    (globalThis as any).AudioContext = function (opts?: any) {
      const c = new MockCtx(opts);
      c.audioWorklet!.shouldFail = true;
      currentCtx = c;
      return c;
    } as any;
    await a.init();
    expect((a as any).workletNode).toBeNull();
    expect((a as any).processor).not.toBeNull();
  });

  it('init() is idempotent: a second call with a running context is a no-op', async () => {
    const a = await freshAudio();
    await a.init();
    const ctxBefore = a.ctx;
    await a.init();
    expect(a.ctx).toBe(ctxBefore);
  });

  it('init() on a suspended context awaits resume', async () => {
    const a = await freshAudio();
    await a.init();
    (a.ctx as any).state = 'suspended';
    await a.init();
    expect((a.ctx as unknown as MockCtx).resumeCount).toBe(1);
    expect((a.ctx as unknown as MockCtx).state).toBe('running');
  });
});

describe('Audio.init — ScriptProcessor fallback (no SharedArrayBuffer)', () => {
  it('uses fallback when SharedArrayBuffer is unavailable', async () => {
    (globalThis as any).__sabBackup = (globalThis as any).SharedArrayBuffer;
    (globalThis as any).SharedArrayBuffer = undefined;
    sabAvailable = false;
    const a = await freshAudio();
    await a.init();
    expect((a as any).workletNode).toBeNull();
    expect((a as any).processor).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// pushSample / bufferedSamples — worklet path
// ─────────────────────────────────────────────────────────────────────────

describe('Audio.pushSample + bufferedSamples — worklet path', () => {
  it('initial state: buffer is empty', async () => {
    const a = await freshAudio();
    await a.init();
    expect(a.bufferedSamples()).toBe(0);
  });

  it('one pushed sample lands at the head and bufferedSamples = 1', async () => {
    const a = await freshAudio();
    await a.init();
    a.pushSample(0.5, -0.25);
    expect(a.bufferedSamples()).toBe(1);
    expect(ring(a).l[0]).toBeCloseTo(0.5);
    expect(ring(a).r[0]).toBeCloseTo(-0.25);
  });

  it('writePos advances and wraps at RING_SIZE', async () => {
    const a = await freshAudio();
    await a.init();
    const pos = ring(a).pos;
    for (let i = 0; i < RING_SIZE + 5; i++) {
      a.pushSample(i, 0);
      Atomics.store(pos, 1, Atomics.load(pos, 0)); // simulate consumer keeping up
    }
    expect(Atomics.load(pos, 0)).toBe(5);
    expect(a.bufferedSamples()).toBe(0);
  });

  it('fills to RING_SIZE-1 then refuses further writes (one slot reserved)', async () => {
    const a = await freshAudio();
    await a.init();
    for (let i = 0; i < RING_SIZE - 1; i++) a.pushSample(i, 0);
    expect(a.bufferedSamples()).toBe(RING_SIZE - 1);

    const pos = ring(a).pos;
    const wpBefore = Atomics.load(pos, 0);
    a.pushSample(999, 999);
    expect(Atomics.load(pos, 0)).toBe(wpBefore);
    expect(a.bufferedSamples()).toBe(RING_SIZE - 1);
  });

  it('reports correct count across a producer/consumer wraparound', async () => {
    const a = await freshAudio();
    await a.init();
    const pos = ring(a).pos;
    Atomics.store(pos, 0, RING_SIZE - 3);
    Atomics.store(pos, 1, RING_SIZE - 3);
    for (let i = 0; i < 5; i++) a.pushSample(i, 0);
    expect(a.bufferedSamples()).toBe(5);
    expect(Atomics.load(pos, 0)).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// pushSample / bufferedSamples — fallback path
// ─────────────────────────────────────────────────────────────────────────

describe('Audio.pushSample + bufferedSamples — fallback path', () => {
  async function fallbackAudio() {
    workletNodeShouldThrow = true;
    const a = await freshAudio();
    await a.init();
    return a;
  }

  it('initial buffer is empty', async () => {
    const a = await fallbackAudio();
    expect(a.bufferedSamples()).toBe(0);
  });

  it('one push lands at writePos=0; bufferedSamples = 1', async () => {
    const a = await fallbackAudio();
    a.pushSample(0.5, -0.25);
    expect(a.bufferedSamples()).toBe(1);
    expect(ring(a).l[0]).toBeCloseTo(0.5);
    expect(ring(a).r[0]).toBeCloseTo(-0.25);
    expect(Atomics.load(ring(a).pos, 0)).toBe(1);
  });

  it('fills to RING_SIZE-1 then drops further writes', async () => {
    const a = await fallbackAudio();
    for (let i = 0; i < RING_SIZE - 1; i++) a.pushSample(i, 0);
    expect(a.bufferedSamples()).toBe(RING_SIZE - 1);
    const wpBefore = Atomics.load(ring(a).pos, 0);
    a.pushSample(999, 999);
    expect(Atomics.load(ring(a).pos, 0)).toBe(wpBefore);
    expect(a.bufferedSamples()).toBe(RING_SIZE - 1);
  });

  it('reports correct count across writer wraparound', async () => {
    const a = await fallbackAudio();
    Atomics.store(ring(a).pos, 0, RING_SIZE - 3);
    Atomics.store(ring(a).pos, 1, RING_SIZE - 3);
    for (let i = 0; i < 5; i++) a.pushSample(i, 0);
    expect(a.bufferedSamples()).toBe(5);
    expect(Atomics.load(ring(a).pos, 0)).toBe(2);
  });

  it('audioCallback after destroy fills the output with silence (no crash on null ring)', async () => {
    const a = await fallbackAudio();
    const proc = (a as any).processor as MockScriptProcessor;
    const cb = proc.onaudioprocess!;
    a.destroy();
    const outL = new Float32Array(4).fill(0.99);
    const outR = new Float32Array(4).fill(0.99);
    const e = {
      outputBuffer: { getChannelData: (ch: number) => (ch === 0 ? outL : outR) },
    } as unknown as AudioProcessingEvent;
    expect(() => cb(e)).not.toThrow();
    expect(Array.from(outL)).toEqual([0, 0, 0, 0]);
    expect(Array.from(outR)).toEqual([0, 0, 0, 0]);
  });

  it('audioCallback drains the ring into the output buffer; zero-pads on underrun', async () => {
    const a = await fallbackAudio();
    a.pushSample(0.1, -0.1);
    a.pushSample(0.2, -0.2);
    a.pushSample(0.3, -0.3);

    const outL = new Float32Array(8);
    const outR = new Float32Array(8);
    const e = {
      outputBuffer: { getChannelData: (ch: number) => (ch === 0 ? outL : outR) },
    } as unknown as AudioProcessingEvent;
    ((a as any).processor as MockScriptProcessor).onaudioprocess!(e);

    expect(outL[0]).toBeCloseTo(0.1, 5);
    expect(outL[1]).toBeCloseTo(0.2, 5);
    expect(outL[2]).toBeCloseTo(0.3, 5);
    expect(outR[0]).toBeCloseTo(-0.1, 5);
    expect(outL[3]).toBe(0);
    expect(outR[3]).toBe(0);
    expect(outL[7]).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// setVolume — bug fixes pinned here
// ─────────────────────────────────────────────────────────────────────────

describe('Audio.setVolume', () => {
  it('clamps below 0 to 0', async () => {
    const a = await freshAudio();
    await a.init();
    a.setVolume(-1);
    expect((a as any).gainNode.gain.value).toBe(0);
  });

  it('clamps above 1 to 1', async () => {
    const a = await freshAudio();
    await a.init();
    a.setVolume(2);
    expect((a as any).gainNode.gain.value).toBe(1);
  });

  it('passes a normal volume through verbatim', async () => {
    const a = await freshAudio();
    await a.init();
    a.setVolume(0.3);
    expect((a as any).gainNode.gain.value).toBeCloseTo(0.3);
  });

  it('does not throw if called before init() (no gain node yet)', async () => {
    const a = await freshAudio();
    expect(() => a.setVolume(0.5)).not.toThrow();
  });

  it('setVolume(NaN) preserves the existing volume (does not propagate NaN)', async () => {
    const a = await freshAudio();
    await a.init();
    a.setVolume(0.4);
    a.setVolume(NaN);
    expect(Number.isFinite((a as any).gainNode.gain.value)).toBe(true);
    expect((a as any).gainNode.gain.value).toBeCloseTo(0.4);
  });

  it('setVolume(Infinity) preserves the existing volume', async () => {
    const a = await freshAudio();
    await a.init();
    a.setVolume(0.4);
    a.setVolume(Infinity);
    expect((a as any).gainNode.gain.value).toBeCloseTo(0.4);
  });

  it('setVolume before init() is remembered and applied at init()', async () => {
    const a = await freshAudio();
    a.setVolume(0.2);
    await a.init();
    expect((a as any).gainNode.gain.value).toBeCloseTo(0.2);
  });

  it('default pre-init volume is 0.7 (matches the previous hard-coded default)', async () => {
    const a = await freshAudio();
    await a.init();
    expect((a as any).gainNode.gain.value).toBeCloseTo(0.7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// reset
// ─────────────────────────────────────────────────────────────────────────

describe('Audio.reset', () => {
  it('clears head/tail and zeroes the ring (worklet path)', async () => {
    const a = await freshAudio();
    await a.init();
    const pos = ring(a).pos;
    for (let i = 0; i < 10; i++) a.pushSample(0.5, 0.5);
    expect(Atomics.load(pos, 0)).toBe(10);

    a.reset();
    expect(Atomics.load(pos, 0)).toBe(0);
    expect(Atomics.load(pos, 1)).toBe(0);
    expect(ring(a).l[0]).toBe(0);
    expect(ring(a).r[5]).toBe(0);
    expect(a.bufferedSamples()).toBe(0);
  });

  it('clears head/tail and zeroes the ring (fallback path)', async () => {
    workletNodeShouldThrow = true;
    const a = await freshAudio();
    await a.init();
    for (let i = 0; i < 10; i++) a.pushSample(0.5, 0.5);
    expect(Atomics.load(ring(a).pos, 0)).toBe(10);

    a.reset();
    expect(Atomics.load(ring(a).pos, 0)).toBe(0);
    expect(Atomics.load(ring(a).pos, 1)).toBe(0);
    expect(ring(a).l[0]).toBe(0);
    expect(ring(a).r[5]).toBe(0);
    expect(a.bufferedSamples()).toBe(0);
  });

  it('is a safe no-op after destroy (no ring to reset)', async () => {
    const a = await freshAudio();
    await a.init();
    a.destroy();
    expect(() => a.reset()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// destroy
// ─────────────────────────────────────────────────────────────────────────

describe('Audio.destroy', () => {
  it('disconnects nodes, closes the context, and nulls handles (worklet path)', async () => {
    const a = await freshAudio();
    await a.init();
    const ctx = a.ctx as unknown as MockCtx;
    const gain = (a as any).gainNode as MockGain;
    const node = (a as any).workletNode as MockWorkletNode;

    a.destroy();

    expect(node.disconnectCount).toBe(1);
    expect(gain.disconnectCount).toBe(1);
    expect(ctx.closeCount).toBe(1);
    expect(a.ctx).toBeNull();
    expect((a as any).workletNode).toBeNull();
    expect((a as any).gainNode).toBeNull();
    expect((a as any).ring).toBeNull();
    expect(a.running).toBe(false);
  });

  it('disconnects the script processor in fallback mode', async () => {
    workletNodeShouldThrow = true;
    const a = await freshAudio();
    await a.init();
    const proc = (a as any).processor as MockScriptProcessor;
    a.destroy();
    expect(proc.disconnectCount).toBe(1);
    expect((a as any).processor).toBeNull();
    expect((a as any).ring).toBeNull();
  });

  it('is safe to call twice', async () => {
    const a = await freshAudio();
    await a.init();
    a.destroy();
    expect(() => a.destroy()).not.toThrow();
  });

  it('init() after destroy() rebuilds the context cleanly', async () => {
    const a = await freshAudio();
    await a.init();
    a.destroy();
    await a.init();
    expect(a.ctx).not.toBeNull();
    expect(a.running).toBe(true);
    expect((a as any).ring).not.toBeNull();
  });

  it('pushSample after destroy is a safe no-op', async () => {
    const a = await freshAudio();
    await a.init();
    a.destroy();
    expect(() => a.pushSample(0.5, 0.5)).not.toThrow();
  });

  it('bufferedSamples after destroy returns 0 (does not crash on null ring)', async () => {
    const a = await freshAudio();
    await a.init();
    a.pushSample(0.5, 0.5);
    a.destroy();
    expect(a.bufferedSamples()).toBe(0);
  });

  it('preserves pendingVolume across destroy→init (volume persists)', async () => {
    const a = await freshAudio();
    await a.init();
    a.setVolume(0.42);
    a.destroy();
    await a.init();
    expect((a as any).gainNode.gain.value).toBeCloseTo(0.42);
  });

  it('does not leave an unhandled-rejection when ctx.close() rejects', async () => {
    const a = await freshAudio();
    await a.init();
    // Force close() to reject; destroy must swallow it.
    (a.ctx as any).close = () => Promise.reject(new Error('close failed'));
    expect(() => a.destroy()).not.toThrow();
    // Yield to the microtask queue so any unhandled rejection would surface.
    await new Promise((r) => setTimeout(r, 0));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-path equivalence
// ─────────────────────────────────────────────────────────────────────────

describe('Audio — worklet and fallback paths are observationally equivalent', () => {
  async function makeAudio(useWorklet: boolean) {
    workletNodeShouldThrow = !useWorklet;
    const a = await freshAudio();
    await a.init();
    return a;
  }

  it('after pushing N < RING_SIZE samples both paths report N', async () => {
    const w = await makeAudio(true);
    const f = await makeAudio(false);
    for (let i = 0; i < 100; i++) { w.pushSample(0, 0); f.pushSample(0, 0); }
    expect(w.bufferedSamples()).toBe(f.bufferedSamples());
    expect(w.bufferedSamples()).toBe(100);
  });

  it('both paths refuse to overflow past RING_SIZE-1', async () => {
    const w = await makeAudio(true);
    const f = await makeAudio(false);
    for (let i = 0; i < RING_SIZE + 100; i++) {
      w.pushSample(0, 0);
      f.pushSample(0, 0);
    }
    expect(w.bufferedSamples()).toBe(RING_SIZE - 1);
    expect(f.bufferedSamples()).toBe(RING_SIZE - 1);
  });
});
