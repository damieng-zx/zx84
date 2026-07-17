/**
 * floppy-sound — synthesised drive soundscape.
 *
 * These tests build a recording AudioContext mock and assert the contract
 * via captured node graphs and AudioParam events. They cover pre-attach
 * no-ops, motor edges, seek-to-zero vs single-step, profile switching,
 * and three regressions for bugs found and fixed in the same pass:
 *
 *   (1) stopMotor's deferred cleanup must not tear down a motor that
 *       restarts inside the 200ms cleanup window.
 *   (2) Multi-step click scheduling must clamp at 80 (matching
 *       seekToZero), not queue an unbounded number of buffer sources.
 *   (3) destroy() must clear prevMotor/prevTrack so a fresh attach()
 *       starts from a clean slate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FloppySound } from '@/media/floppy/floppy-sound.ts';

// ─────────────────────────────────────────────────────────────────────────
// Recording AudioContext mock
// ─────────────────────────────────────────────────────────────────────────

class MockParam {
  value = 0;
  events: Array<{ kind: 'set' | 'linear' | 'exp' | 'cancel'; v?: number; t: number }> = [];
  setValueAtTime(v: number, t: number) { this.events.push({ kind: 'set', v, t }); this.value = v; }
  linearRampToValueAtTime(v: number, t: number) { this.events.push({ kind: 'linear', v, t }); }
  exponentialRampToValueAtTime(v: number, t: number) { this.events.push({ kind: 'exp', v, t }); }
  cancelScheduledValues(t: number) { this.events.push({ kind: 'cancel', t }); }
}

class MockNode {
  connected: MockNode[] = [];
  disconnectCount = 0;
  connect(n: MockNode) { this.connected.push(n); return n; }
  disconnect() { this.disconnectCount++; }
}

class MockGain extends MockNode { gain = new MockParam(); }

class MockOsc extends MockNode {
  type = '';
  frequency = new MockParam();
  started: number | null = null;
  stopped: number | null = null;
  start(t: number) { this.started = t; }
  stop(t?: number) { this.stopped = t ?? 0; }
}

class MockBufSrc extends MockNode {
  buffer: any = null;
  loop = false;
  started: number | null = null;
  stopped: number | null = null;
  start(t: number) { this.started = t; }
  stop(t?: number) { this.stopped = t ?? 0; }
}

class MockBiquad extends MockNode {
  type = '';
  frequency = new MockParam();
  Q = new MockParam();
}

class MockCtx {
  sampleRate = 48000;
  currentTime = 0;
  destination = new MockNode();
  oscs: MockOsc[] = [];
  gains: MockGain[] = [];
  bufSrcs: MockBufSrc[] = [];
  biquads: MockBiquad[] = [];
  createGain() { const n = new MockGain(); this.gains.push(n); return n; }
  createOscillator() { const n = new MockOsc(); this.oscs.push(n); return n; }
  createBufferSource() { const n = new MockBufSrc(); this.bufSrcs.push(n); return n; }
  createBiquadFilter() { const n = new MockBiquad(); this.biquads.push(n); return n; }
  createBuffer(_c: number, length: number, _rate: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data, length };
  }
}

let ctx: MockCtx;
let fs: FloppySound;

beforeEach(() => {
  ctx = new MockCtx();
  fs = new FloppySound();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────
// Pre-attach no-ops
// ─────────────────────────────────────────────────────────────────────────

describe('FloppySound — before attach()', () => {
  it('update() does nothing and does not throw', () => {
    expect(() => fs.update(true, 5)).not.toThrow();
    expect(ctx.oscs).toHaveLength(0);
  });

  it('reset() does not throw', () => {
    expect(() => fs.reset()).not.toThrow();
  });

  it('destroy() does not throw', () => {
    expect(() => fs.destroy()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// attach()
// ─────────────────────────────────────────────────────────────────────────

describe('FloppySound — attach()', () => {
  it('creates a master gain at 0.4 and connects it to destination', () => {
    fs.attach(ctx as any);
    expect(ctx.gains).toHaveLength(1);
    expect(ctx.gains[0].gain.value).toBe(0.4);
    expect(ctx.gains[0].connected[0]).toBe(ctx.destination);
  });

  it('is idempotent — a second attach is a no-op', () => {
    fs.attach(ctx as any);
    fs.attach(ctx as any);
    expect(ctx.gains).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Motor lifecycle
// ─────────────────────────────────────────────────────────────────────────

describe('FloppySound — motor on/off', () => {
  beforeEach(() => fs.attach(ctx as any));

  it('starts an oscillator + noise source when motor edges to on', () => {
    const oscBefore = ctx.oscs.length;
    const bufBefore = ctx.bufSrcs.length;
    fs.update(true, 0);
    expect(ctx.oscs.length).toBeGreaterThan(oscBefore);
    expect(ctx.bufSrcs.length).toBeGreaterThan(bufBefore);
    // Motor osc starts at the documented hum freq for 3inch (the default).
    const motorOsc = ctx.oscs.find(o => o.type === 'sine');
    expect(motorOsc).toBeDefined();
    expect(motorOsc!.frequency.value).toBe(120);
    expect(motorOsc!.started).not.toBeNull();
  });

  it('does NOT restart the motor if update is called twice with motor on', () => {
    fs.update(true, 0);
    const oscCount = ctx.oscs.length;
    fs.update(true, 0);
    expect(ctx.oscs.length).toBe(oscCount);
  });

  it('motor off schedules a linear ramp to zero on the motor gain', () => {
    vi.useFakeTimers();
    fs.update(true, 0);
    // Find the motor's own gain envelope (the one with a linear ramp to 1).
    const motorGain = ctx.gains.find(g =>
      g.gain.events.some(e => e.kind === 'linear' && e.v === 1)
    );
    expect(motorGain).toBeDefined();

    fs.update(false, 0);
    const rampDown = motorGain!.gain.events.find(
      e => e.kind === 'linear' && e.v === 0,
    );
    expect(rampDown).toBeDefined();
  });

  it('after stopMotor + 200ms, the motor nodes are stopped and disconnected', () => {
    vi.useFakeTimers();
    fs.update(true, 0);
    const motorOsc = ctx.oscs.find(o => o.type === 'sine')!;
    const motorBuf = ctx.bufSrcs.find(b => b.loop === true)!;
    fs.update(false, 0);
    expect(motorOsc.stopped).toBeNull(); // still scheduled
    vi.advanceTimersByTime(250);
    expect(motorOsc.stopped).not.toBeNull();
    expect(motorBuf.stopped).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Track transitions
// ─────────────────────────────────────────────────────────────────────────

describe('FloppySound — track transitions', () => {
  beforeEach(() => {
    fs.attach(ctx as any);
    fs.update(true, 0); // motor on, sitting at track 0
  });

  function countStepClicks(): number {
    // A step click creates one new BiquadFilter set to 'bandpass' at stepFreq
    // (1200 for 3inch). Counting those — minus the one made by the motor
    // start click (which is also bandpass but at engageLatchFreq 1800) and
    // the motor noise bandpass (160) — gives the click count.
    return ctx.biquads.filter(b => b.type === 'bandpass' && b.frequency.value === 1200).length;
  }

  it('no track change → no step click', () => {
    const before = countStepClicks();
    fs.update(true, 0);
    expect(countStepClicks()).toBe(before);
  });

  it('delta 1 (track 0 → 1) → exactly one step click', () => {
    const before = countStepClicks();
    fs.update(true, 1);
    expect(countStepClicks()).toBe(before + 1);
  });

  it('delta 1 backwards (track 1 → 0) is a single step, NOT a seek-to-zero', () => {
    fs.update(true, 1);
    const before = countStepClicks();
    fs.update(true, 0);
    expect(countStepClicks()).toBe(before + 1);
  });

  it('delta > 1 schedules one step per track in scheduledClicks', () => {
    const before = countStepClicks();
    fs.update(true, 5);
    expect(countStepClicks()).toBe(before + 5);
  });

  it('seek-to-zero (prevTrack > 1, track = 0) emits prevTrack clicks', () => {
    fs.update(true, 10);
    const before = countStepClicks();
    fs.update(true, 0);
    expect(countStepClicks()).toBe(before + 10);
  });

  it('seek-to-zero spaces clicks at seekToZeroInterval, NOT seekInterval', () => {
    // 3inch profile: seekInterval=0.01, seekToZeroInterval=0.008.
    fs.update(true, 5); // prevTrack now 5 (multi-step inward seek used seekInterval).
    const beforeBufCount = ctx.bufSrcs.length;
    fs.update(true, 0); // seek-to-zero, 5 clicks at 0.008 spacing.
    const stepBufs = ctx.bufSrcs.slice(beforeBufCount);
    expect(stepBufs).toHaveLength(5);
    // Each successive click starts at i * 0.008.
    for (let i = 0; i < 5; i++) {
      expect(stepBufs[i].started).toBeCloseTo(i * 0.008, 6);
    }
  });

  it('multi-step seek spaces clicks at seekInterval (0.01 for 3inch)', () => {
    const beforeBufCount = ctx.bufSrcs.length;
    fs.update(true, 5);
    const stepBufs = ctx.bufSrcs.slice(beforeBufCount);
    expect(stepBufs).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(stepBufs[i].started).toBeCloseTo(i * 0.01, 6);
    }
  });

  it('track change with motor OFF is silent', () => {
    fs.update(false, 0); // motor off
    vi.useFakeTimers();
    vi.advanceTimersByTime(300); // let stopMotor cleanup settle
    const before = countStepClicks();
    fs.update(false, 50); // huge track delta but motor off
    expect(countStepClicks()).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Profile switching
// ─────────────────────────────────────────────────────────────────────────

describe('FloppySound — driveType profile', () => {
  it('3.5inch produces step clicks at the higher (2200 Hz) bandpass', () => {
    fs.driveType = '3.5inch';
    fs.attach(ctx as any);
    fs.update(true, 0);
    fs.update(true, 1); // one step
    const stepBandpass = ctx.biquads.find(b => b.type === 'bandpass' && b.frequency.value === 2200);
    expect(stepBandpass).toBeDefined();
    expect(stepBandpass!.Q.value).toBe(3);
  });

  it('3inch motor hum is at 120 Hz; 3.5inch is at 180 Hz', () => {
    fs.attach(ctx as any);
    fs.update(true, 0);
    expect(ctx.oscs.find(o => o.type === 'sine')!.frequency.value).toBe(120);

    // Reset and switch profile.
    const fs2 = new FloppySound();
    fs2.driveType = '3.5inch';
    const ctx2 = new MockCtx();
    fs2.attach(ctx2 as any);
    fs2.update(true, 0);
    expect(ctx2.oscs.find(o => o.type === 'sine')!.frequency.value).toBe(180);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// reset()
// ─────────────────────────────────────────────────────────────────────────

describe('FloppySound — reset()', () => {
  it('clears prevMotor and prevTrack so re-running the same state re-emits sounds', () => {
    fs.attach(ctx as any);
    fs.update(true, 5);            // motor on, track 5
    fs.reset();                     // back to (false, 0)
    // After reset: update(true, 5) must look like a fresh motor start AND
    // a track delta of 5, not "no change".
    const oscBefore = ctx.oscs.length;
    const before = ctx.biquads.filter(b => b.type === 'bandpass' && b.frequency.value === 1200).length;
    fs.update(true, 5);
    const oscAfter = ctx.oscs.length;
    const after = ctx.biquads.filter(b => b.type === 'bandpass' && b.frequency.value === 1200).length;
    expect(oscAfter).toBeGreaterThan(oscBefore);  // motor restarted
    expect(after - before).toBe(5);                // five step clicks
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Surfaced bugs (it.fails — failing today, will pass when fixed)
// ─────────────────────────────────────────────────────────────────────────

describe('FloppySound — regressions', () => {
  // Regression for the cleanup-vs-restart race: stopMotor must capture the
  // nodes it owns in its closure rather than reading this.motorOsc at fire
  // time, otherwise a new motor started inside the 200ms window gets torn
  // down by the old cleanup.
  it('rapid stop→start within 200ms must not tear down the restarted motor', () => {
    vi.useFakeTimers();
    fs.attach(ctx as any);
    fs.update(true, 0);
    const firstOsc = ctx.oscs.find(o => o.type === 'sine')!;

    fs.update(false, 0);   // stop scheduled at +200ms
    vi.advanceTimersByTime(50); // 150ms left on the cleanup timer
    fs.update(true, 0);    // restart
    const secondOsc = ctx.oscs.filter(o => o.type === 'sine').pop()!;
    expect(secondOsc).not.toBe(firstOsc);

    vi.advanceTimersByTime(200); // original cleanup timer fires here
    // BUG: cleanup() reads this.motorOsc, which now references the new osc,
    // and stops it. Correct behaviour: the cleanup belonging to the old
    // motor should not touch the new one.
    expect(secondOsc.stopped).toBeNull();
  });

  // Regression for the unbounded-scheduledClicks bug: both paths now
  // funnel through a single scheduleSteps() helper that clamps at 80.
  it('large track delta is clamped at 80 (parity with seekToZero)', () => {
    fs.attach(ctx as any);
    fs.update(true, 0);
    const before = ctx.bufSrcs.length;
    fs.update(true, 500);
    const clicksScheduled = ctx.bufSrcs.length - before;
    expect(clicksScheduled).toBeLessThanOrEqual(80);
  });

  // Regression for the destroy-leaves-stale-edge-state bug. destroy() now
  // funnels through reset() so prevMotor/prevTrack are always cleared.
  it('destroy() clears edge state so re-attach starts from a clean slate', () => {
    fs.attach(ctx as any);
    fs.update(true, 5);
    fs.destroy();

    // Re-attach to a fresh context.
    const ctx2 = new MockCtx();
    fs.attach(ctx2 as any);
    // After re-attach, sending (true, 5) again should detect motor-on (prev
    // was reset). If destroy() didn't clear prevMotor, the edge is missed
    // and no motor sound starts.
    fs.update(true, 5);
    const motorOsc = ctx2.oscs.find(o => o.type === 'sine');
    expect(motorOsc).toBeDefined();
  });
});
