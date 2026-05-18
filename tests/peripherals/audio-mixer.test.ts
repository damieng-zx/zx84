/**
 * Tests for AudioMixer.
 *
 * Lock-ins for previously-fragile behaviour:
 *  - Constructor pre-populates beeperDCAlpha (44100 Hz default) so an
 *    init()-less mixer doesn't silently mute.
 *  - generateSamples() spreads accumulated duty proportionally across
 *    catch-up sample windows instead of dumping it into the first sample
 *    and zeroing the rest.
 *  - beeperGain / ayGain setters clamp to [0, 1].
 *  - accumulate() coerces beeperBit to its low bit.
 *  - init() drops in-flight accumulator state so a sample-rate change
 *    can't reinterpret old T-state counts in the new window size.
 */
import { describe, it, expect } from 'vitest';
import { AudioMixer } from '@/peripherals/audio-mixer.ts';
import type { Audio } from '@/audio.ts';
import type { AY3891x } from '@/cores/ay-3-8910.ts';

// ── Fakes ──────────────────────────────────────────────────────────────────

interface CapturedSample { left: number; right: number; }

function fakeAudio(): Audio & { samples: CapturedSample[] } {
  const samples: CapturedSample[] = [];
  return {
    samples,
    pushSample(left: number, right: number) { samples.push({ left, right }); },
  } as unknown as Audio & { samples: CapturedSample[] };
}

function fakeAY(left: number, right: number): AY3891x {
  let calls = 0;
  const ay = {
    calls: () => calls,
    generateSampleStereo() {
      calls++;
      return { left, right };
    },
  };
  return ay as unknown as AY3891x;
}

// ── Construction ───────────────────────────────────────────────────────────

describe('AudioMixer — construction & init', () => {
  it('constructor pre-populates tStatesPerSample for 44100 Hz output (no init() yet)', () => {
    const m = new AudioMixer(3_500_000);
    expect(m.tStatesPerSample).toBeCloseTo(3_500_000 / 44100, 6);
  });

  it('cpuClock scales tStatesPerSample linearly', () => {
    const m = new AudioMixer(7_000_000);
    expect(m.tStatesPerSample).toBeCloseTo(7_000_000 / 44100, 6);
  });

  it('init(sampleRate) recomputes tStatesPerSample and DC alpha', () => {
    const m = new AudioMixer(3_500_000);
    m.init(48_000);
    expect(m.tStatesPerSample).toBeCloseTo(3_500_000 / 48_000, 6);
    // ~20Hz HPF cutoff: alpha = 1 - 2π·20/sampleRate
    const expectedAlpha = 1 - (2 * Math.PI * 20 / 48_000);
    expect((m as any).beeperDCAlpha).toBeCloseTo(expectedAlpha, 8);
  });

  it('without init(), the constructor pre-populates a usable DC alpha (44.1kHz default)', () => {
    // Regression guard: pre-fix, beeperDCAlpha defaulted to 0 and the mixer
    // played silence until someone called init().
    const m = new AudioMixer(3_500_000);
    expect((m as any).beeperDCAlpha).toBeCloseTo(1 - (2 * Math.PI * 20 / 44_100), 8);

    const audio = fakeAudio();
    m.accumulate(1, Math.ceil(m.tStatesPerSample));
    m.generateSamples(audio, null, false);
    expect(audio.samples.length).toBeGreaterThan(0);
    expect(audio.samples[0]!.left).toBeGreaterThan(0); // not silenced
  });

  it('init() drops in-flight accumulator state to avoid sample-rate reinterpretation', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    m.accumulate(1, 100);
    expect(m.beeperTStatesAccum).toBe(100);
    m.init(48_000); // mid-stream sample-rate change
    expect(m.beeperTStatesAccum).toBe(0);
    expect((m as any).beeperAccum).toBe(0);
  });
});

// ── Accumulation ───────────────────────────────────────────────────────────

describe('AudioMixer — accumulate', () => {
  it('separately tracks weighted bit accumulator and T-state counter', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    m.accumulate(1, 10);
    m.accumulate(0, 30);
    m.accumulate(1, 20);
    expect(m.beeperTStatesAccum).toBe(60);
    expect((m as any).beeperAccum).toBe(30); // bit*elapsed summed
  });

  it('elapsed=0 is a no-op', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    m.accumulate(1, 0);
    expect(m.beeperTStatesAccum).toBe(0);
    expect((m as any).beeperAccum).toBe(0);
  });

  it('coerces beeperBit to its low bit (defends against misuse)', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    m.accumulate(2, 10);   // even → bit 0
    m.accumulate(3, 10);   // odd  → bit 1
    m.accumulate(-1, 10);  // -1 & 1 → 1
    expect((m as any).beeperAccum).toBe(20);
    expect(m.beeperTStatesAccum).toBe(30);
  });
});

// ── Sample generation: thresholding ────────────────────────────────────────

describe('AudioMixer — generateSamples threshold', () => {
  it('produces no samples until tStatesPerSample is reached', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    const audio = fakeAudio();
    // One T-state short of a full sample window.
    m.accumulate(1, Math.floor(m.tStatesPerSample) - 1);
    m.generateSamples(audio, null, false);
    expect(audio.samples).toEqual([]);
  });

  it('produces one sample per full sample window', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    const audio = fakeAudio();
    const N = m.tStatesPerSample;
    // Exactly 3 sample windows.
    m.accumulate(1, Math.ceil(N * 3));
    m.generateSamples(audio, null, false);
    expect(audio.samples.length).toBe(3);
  });

  it('drains beeperTStatesAccum down to a sub-sample remainder', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    const audio = fakeAudio();
    const N = m.tStatesPerSample;
    m.accumulate(1, Math.ceil(N * 2.5));
    m.generateSamples(audio, null, false);
    // 2 full samples drawn; remainder should be < N.
    expect(audio.samples.length).toBe(2);
    expect(m.beeperTStatesAccum).toBeLessThan(N);
    expect(m.beeperTStatesAccum).toBeGreaterThan(0);
  });
});

// ── DC filter behaviour ────────────────────────────────────────────────────

describe('AudioMixer — DC-blocking filter', () => {
  it('passes a transient through, then decays to zero on constant input', () => {
    // Pick a sample rate that divides cpuClock evenly so the duty can't
    // round-trip to >1.0 from a Math.ceil() window. 3.5MHz / 50_000 = 70 T/sample.
    const m = new AudioMixer(3_500_000);
    m.init(50_000);
    const audio = fakeAudio();
    const N = m.tStatesPerSample; // 70 exactly

    // First sample: beeper high → output should be positive (alpha · 0.8 · 1.0).
    m.accumulate(1, N);
    m.generateSamples(audio, null, false);
    expect(audio.samples.length).toBe(1);
    const first = audio.samples[0]!.left;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(0.8); // beeperRaw = duty(=1) · 0.8

    // Sustain beeper high for many more samples: DC component must decay.
    for (let i = 0; i < 1000; i++) {
      m.accumulate(1, N);
      m.generateSamples(audio, null, false);
    }
    const last = audio.samples[audio.samples.length - 1]!.left;
    expect(Math.abs(last)).toBeLessThan(Math.abs(first) / 10);
  });

  it('a static-zero beeper produces exactly zero output once warmed up', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    const audio = fakeAudio();
    const N = m.tStatesPerSample;
    for (let i = 0; i < 50; i++) {
      m.accumulate(0, Math.ceil(N));
      m.generateSamples(audio, null, false);
    }
    for (const s of audio.samples) {
      expect(s.left).toBe(0);
      expect(s.right).toBe(0);
    }
  });
});

// ── 48K vs 128K routing ────────────────────────────────────────────────────

describe('AudioMixer — 48K vs 128K routing', () => {
  it('48K path is beeper-only, AY is not consulted even if passed', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    const audio = fakeAudio();
    const ay = fakeAY(0.5, -0.5);
    m.accumulate(1, Math.ceil(m.tStatesPerSample));
    m.generateSamples(audio, ay, /* is128k */ false);
    expect((ay as any).calls()).toBe(0);
    // Left == right (mono beeper duplicated).
    expect(audio.samples[0]!.left).toBe(audio.samples[0]!.right);
  });

  it('128K but ay=null safely falls through to beeper-only path', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    const audio = fakeAudio();
    m.accumulate(1, Math.ceil(m.tStatesPerSample));
    expect(() =>
      m.generateSamples(audio, null, /* is128k */ true),
    ).not.toThrow();
    expect(audio.samples.length).toBe(1);
    expect(audio.samples[0]!.left).toBe(audio.samples[0]!.right);
  });

  it('128K with AY mixes stereo AY into beeper output (independent L/R)', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    const audio = fakeAudio();
    const ay = fakeAY(0.3, -0.3);
    m.accumulate(0, Math.ceil(m.tStatesPerSample)); // beeper off → ~0 contribution
    // Warm up the DC filter so beeper component ≈ 0.
    for (let i = 0; i < 50; i++) {
      m.accumulate(0, Math.ceil(m.tStatesPerSample));
      m.generateSamples(audio, ay, true);
    }
    const s = audio.samples[audio.samples.length - 1]!;
    expect(s.left).toBeCloseTo(0.3, 6);
    expect(s.right).toBeCloseTo(-0.3, 6);
  });

  it('AY is sampled once per output sample (no aliasing across windows)', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    const audio = fakeAudio();
    const ay = fakeAY(0, 0);
    m.accumulate(0, Math.ceil(m.tStatesPerSample * 5));
    m.generateSamples(audio, ay, true);
    expect(audio.samples.length).toBe(5);
    expect((ay as any).calls()).toBe(5);
  });
});

// ── Gain & clipping ────────────────────────────────────────────────────────

describe('AudioMixer — gain & clipping', () => {
  it('clips combined samples to [-1, 1]', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    const audio = fakeAudio();
    const ay = fakeAY(2, -2); // out-of-range AY samples
    m.ayGain = 1.0;
    m.beeperGain = 0;
    m.accumulate(0, Math.ceil(m.tStatesPerSample));
    m.generateSamples(audio, ay, true);
    expect(audio.samples[0]!.left).toBe(1);
    expect(audio.samples[0]!.right).toBe(-1);
  });

  it('ayGain=0 mutes the AY entirely', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    const audio = fakeAudio();
    const ay = fakeAY(0.5, 0.5);
    m.ayGain = 0;
    m.beeperGain = 0; // mute beeper too
    m.accumulate(0, Math.ceil(m.tStatesPerSample));
    m.generateSamples(audio, ay, true);
    expect(audio.samples[0]!.left).toBe(0);
    expect(audio.samples[0]!.right).toBe(0);
  });

  it('beeperGain=0 mutes the beeper without disturbing AY', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    const audio = fakeAudio();
    const ay = fakeAY(0.2, -0.2);
    m.beeperGain = 0;
    m.accumulate(1, Math.ceil(m.tStatesPerSample));
    m.generateSamples(audio, ay, true);
    expect(audio.samples[0]!.left).toBeCloseTo(0.2, 6);
    expect(audio.samples[0]!.right).toBeCloseTo(-0.2, 6);
  });

  it('clamps gain setters to [0, 1] (no phase-invert, no amplification)', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    m.ayGain = -1;
    expect(m.ayGain).toBe(0);
    m.ayGain = 5;
    expect(m.ayGain).toBe(1);
    m.beeperGain = -0.5;
    expect(m.beeperGain).toBe(0);
    m.beeperGain = 2;
    expect(m.beeperGain).toBe(1);
    // Sanity-check the output path can't phase-invert via a negative gain.
    m.ayGain = -1; // clamped to 0
    m.beeperGain = 0;
    const audio = fakeAudio();
    const ay = fakeAY(0.4, 0.4);
    m.accumulate(0, Math.ceil(m.tStatesPerSample));
    m.generateSamples(audio, ay, true);
    expect(audio.samples[0]!.left).toBe(0);
    expect(audio.samples[0]!.right).toBe(0);
  });
});

// ── Reset ──────────────────────────────────────────────────────────────────

describe('AudioMixer — reset()', () => {
  it('clears all per-sample state but leaves config intact', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    m.beeperGain = 0.7;
    m.ayGain = 0.3;
    m.prevBeeperBit = 1;
    m.accumulate(1, 50);
    // Pump some samples to populate DC filter state.
    const audio = fakeAudio();
    for (let i = 0; i < 10; i++) {
      m.accumulate(1, Math.ceil(m.tStatesPerSample));
      m.generateSamples(audio, null, false);
    }

    m.reset();

    expect(m.beeperTStatesAccum).toBe(0);
    expect((m as any).beeperAccum).toBe(0);
    expect((m as any).beeperDCPrev).toBe(0);
    expect((m as any).beeperDCOut).toBe(0);
    expect(m.prevBeeperBit).toBe(0);
    // Config preserved.
    expect(m.beeperGain).toBe(0.7);
    expect(m.ayGain).toBe(0.3);
    expect(m.tStatesPerSample).toBeCloseTo(3_500_000 / 44_100, 6);
    expect((m as any).beeperDCAlpha).not.toBe(0);
  });
});

// ── Catch-up: large-elapsed accumulate must spread duty across windows ─────

describe('AudioMixer — accumulator catch-up semantics', () => {
  it('spreads a constant-high burst across all pending sample windows', () => {
    // Regression guard for the old "zero beeperAccum after each sample" bug.
    // 4 windows of bit=1 in one accumulate call must yield 4 samples that all
    // reflect duty≈1.0, not 1 saturated sample + 3 silent.
    const m = new AudioMixer(3_500_000);
    m.init(50_000); // 70 T/sample exactly
    const audio = fakeAudio();
    const N = m.tStatesPerSample;

    m.accumulate(1, N * 4);
    m.generateSamples(audio, null, false);

    expect(audio.samples.length).toBe(4);
    // First sample carries the HPF transient; later samples decay toward 0.
    // What matters: the burst is reflected in the SUM of energy, not piled
    // into one sample. Pre-fix: sample[0] ≈ 0.8, samples[1..3] ≈ 0.
    // Post-fix: sample[0] is large, samples[1..3] are smaller but the
    // ABSOLUTE sum of the tail is comparable to a continuous-input case.
    const sumAbs = audio.samples.reduce((a, s) => a + Math.abs(s.left), 0);
    // With duty spread evenly, sample[0] alone ≈ alpha · 0.8 ≈ 0.799.
    // Subsequent samples each contribute via the HPF leak: y[n]=alpha·y[n-1]
    // when x is constant. Sum ≈ 0.799 · (1 + alpha + alpha² + alpha³).
    // For alpha ≈ 0.99749 this is ≈ 0.799 · 3.985 ≈ 3.18.
    expect(sumAbs).toBeGreaterThan(3.0);
  });

  it('a constant-high burst played sample-by-sample matches one played as a single burst', () => {
    // Stronger guarantee: catch-up output equals incremental output, modulo
    // floating-point rounding. (This is what makes snapshot restore / step-frame
    // sound right.)
    const cpuClock = 3_500_000;
    const rate = 50_000;
    const N = cpuClock / rate;

    const incremental = new AudioMixer(cpuClock); incremental.init(rate);
    const burst       = new AudioMixer(cpuClock); burst.init(rate);
    const audioInc = fakeAudio();
    const audioBst = fakeAudio();

    for (let i = 0; i < 8; i++) {
      incremental.accumulate(1, N);
      incremental.generateSamples(audioInc, null, false);
    }
    burst.accumulate(1, N * 8);
    burst.generateSamples(audioBst, null, false);

    expect(audioBst.samples.length).toBe(audioInc.samples.length);
    for (let i = 0; i < audioInc.samples.length; i++) {
      expect(audioBst.samples[i]!.left).toBeCloseTo(audioInc.samples[i]!.left, 9);
      expect(audioBst.samples[i]!.right).toBeCloseTo(audioInc.samples[i]!.right, 9);
    }
  });

  it('a constant-low burst stays at zero across the whole window', () => {
    const m = new AudioMixer(3_500_000);
    m.init(50_000);
    const audio = fakeAudio();
    const N = m.tStatesPerSample;
    m.accumulate(0, N * 8);
    m.generateSamples(audio, null, false);
    expect(audio.samples.length).toBe(8);
    for (const s of audio.samples) expect(s.left).toBe(0);
  });
});
