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
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import type { Audio } from '@/audio.ts';
import type { AY3891x } from '@/cores/ay-3-8910.ts';

// ââ Fakes ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// ââ Construction âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

describe('AudioMixer â construction & init', () => {
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
    // ~20Hz HPF cutoff: alpha = 1 - 2ÏÂ·20/sampleRate
    const expectedAlpha = 1 - (2 * Math.PI * 20 / 48_000);
    expect((m as any).beeperDCAlpha).toBeCloseTo(expectedAlpha, 8);
  });

  it('without init(), the constructor pre-populates a usable DC alpha (44.1kHz default)', () => {
    // Regression guard: pre-fix, beeperDCAlpha defaulted to 0 and the mixer
    // played silence until someone called init().
    const m = new AudioMixer(3_500_000);
    expect((m as any).beeperDCAlpha).toBeCloseTo(1 - (2 * Math.PI * 20 / 44_100), 8);

    const audio = fakeAudio();
    // The first sample only seeds the filter (a signal already at a DC level starts
    // at zero), so give it a step to pass through.
    m.accumulate(0, Math.ceil(m.tStatesPerSample));
    m.generateSamples(audio, null, false);
    m.accumulate(1, Math.ceil(m.tStatesPerSample));
    m.generateSamples(audio, null, false);
    expect(audio.samples.length).toBeGreaterThan(1);
    expect(audio.samples[1]!.left).toBeGreaterThan(0); // not silenced
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

// ââ Accumulation âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

describe('AudioMixer â accumulate', () => {
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
    m.accumulate(2, 10);   // even â bit 0
    m.accumulate(3, 10);   // odd  â bit 1
    m.accumulate(-1, 10);  // -1 & 1 â 1
    expect((m as any).beeperAccum).toBe(20);
    expect(m.beeperTStatesAccum).toBe(30);
  });
  it('accumulateLevel weights by a fractional level without masking', () => {
    const m = new AudioMixer(3_500_000);
    m.init(44_100);
    m.accumulateLevel(0.1, 10);  // 1
    m.accumulateLevel(1, 20);    // 20
    m.accumulateLevel(0, 30);    // 0
    expect((m as any).beeperAccum).toBeCloseTo(21, 9);
    expect(m.beeperTStatesAccum).toBe(60);
  });
});

// ââ Sample generation: thresholding ââââââââââââââââââââââââââââââââââââââââ

describe('AudioMixer â generateSamples threshold', () => {
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

// ââ DC filter behaviour ââââââââââââââââââââââââââââââââââââââââââââââââââââ

describe('AudioMixer â DC-blocking filter', () => {
  it('passes a transient through, then decays to zero on constant input', () => {
    // Pick a sample rate that divides cpuClock evenly so the duty can't
    // round-trip to >1.0 from a Math.ceil() window. 3.5MHz / 50_000 = 70 T/sample.
    const m = new AudioMixer(3_500_000);
    m.init(50_000);
    const audio = fakeAudio();
    const N = m.tStatesPerSample; // 70 exactly

    // A settled-low sample first (it seeds the filter), then the step.
    m.accumulate(0, N);
    m.generateSamples(audio, null, false);

    // Beeper goes high â output should be positive (alpha Â· 0.8 Â· 1.0).
    m.accumulate(1, N);
    m.generateSamples(audio, null, false);
    expect(audio.samples.length).toBe(2);
    const first = audio.samples[1]!.left;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(0.8); // beeperRaw = duty(=1) Â· 0.8

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

// ââ 48K vs 128K routing ââââââââââââââââââââââââââââââââââââââââââââââââââââ

describe('AudioMixer â 48K vs 128K routing', () => {
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
    m.accumulate(0, Math.ceil(m.tStatesPerSample)); // beeper off â ~0 contribution
    // Warm up the DC filter so beeper component â 0.
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

// ââ Gain & clipping ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

describe('AudioMixer â gain & clipping', () => {
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

// ââ Reset ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

describe('AudioMixer â reset()', () => {
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

// ââ Catch-up: large-elapsed accumulate must spread duty across windows âââââ

describe('AudioMixer â accumulator catch-up semantics', () => {
  it('spreads a constant-high burst across all pending sample windows', () => {
    // Regression guard for the old "zero beeperAccum after each sample" bug.
    // 4 windows of bit=1 in one accumulate call must yield 4 samples that all
    // reflect dutyâ1.0, not 1 saturated sample + 3 silent.
    const m = new AudioMixer(3_500_000);
    m.init(50_000); // 70 T/sample exactly
    const audio = fakeAudio();
    const N = m.tStatesPerSample;

    m.accumulate(0, N);            // settled-low sample: seeds the filter
    m.generateSamples(audio, null, false);
    audio.samples.length = 0;

    m.accumulate(1, N * 4);
    m.generateSamples(audio, null, false);

    expect(audio.samples.length).toBe(4);
    // First sample carries the HPF transient; later samples decay toward 0.
    // What matters: the burst is reflected in the SUM of energy, not piled
    // into one sample. Pre-fix: sample[0] â 0.8, samples[1..3] â 0.
    // Post-fix: sample[0] is large, samples[1..3] are smaller but the
    // ABSOLUTE sum of the tail is comparable to a continuous-input case.
    const sumAbs = audio.samples.reduce((a, s) => a + Math.abs(s.left), 0);
    // With duty spread evenly, sample[0] alone â alpha Â· 0.8 â 0.799.
    // Subsequent samples each contribute via the HPF leak: y[n]=alphaÂ·y[n-1]
    // when x is constant. Sum â 0.799 Â· (1 + alpha + alphaÂ² + alphaÂ³).
    // For alpha â 0.99749 this is â 0.799 Â· 3.985 â 3.18.
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

// ── Filter priming, sample-boundary split, discardPending ──────────────────

describe('AudioMixer — beeper filter priming', () => {
  const N = 70;
  const mk = () => { const m = new AudioMixer(3_500_000); m.init(50_000); return m; };

  it('a signal that is already at a DC level from the first sample comes out silent', () => {
    const m = mk();
    const audio = fakeAudio();
    for (let i = 0; i < 20; i++) { m.accumulate(1, N); m.generateSamples(audio, null, false); }
    for (const s of audio.samples) expect(s.left).toBe(0);
  });

  it('after reset() a held-high beeper does not step (no thump when the mixer is reset mid-stream)', () => {
    const m = mk();
    const audio = fakeAudio();
    m.accumulate(0, N); m.generateSamples(audio, null, false);
    m.accumulate(1, N); m.generateSamples(audio, null, false);   // real step: audible
    expect(audio.samples[1]!.left).toBeGreaterThan(0.5);
    m.reset();
    audio.samples.length = 0;
    m.accumulate(1, N); m.generateSamples(audio, null, false);   // still high, but this is now DC
    expect(audio.samples[0]!.left).toBe(0);
  });

  it('a genuine edge after priming still passes through at full size (alpha * 0.8)', () => {
    const m = mk();
    const audio = fakeAudio();
    m.accumulate(0, N); m.generateSamples(audio, null, false);
    m.accumulate(1, N); m.generateSamples(audio, null, false);
    expect(audio.samples[1]!.left).toBeCloseTo(0.8 * (1 - 2 * Math.PI * 20 / 50_000), 12);
  });
});

describe('AudioMixer — sample-boundary split', () => {
  const ALPHA = 1 - (2 * Math.PI * 20 / 50_000);

  it('cuts an instruction that straddles the boundary instead of averaging it into both samples', () => {
    const m = new AudioMixer(3_500_000);
    m.init(50_000); // 70 T per sample
    const audio = fakeAudio();
    m.accumulate(0, 70); m.generateSamples(audio, null, false);   // seeds the filter at 0

    // 60 T low, then one 20 T instruction high: window = 80 T, so the sample takes
    // 10 T of the high run and the remaining 10 T start the next sample.
    m.accumulate(0, 60); m.generateSamples(audio, null, false);
    m.accumulate(1, 20); m.generateSamples(audio, null, false);
    expect(audio.samples.length).toBe(2);
    const y1 = ALPHA * (0.8 * (10 / 70));                         // duty 10/70, not 20/80
    expect(audio.samples[1]!.left).toBeCloseTo(y1, 12);

    // Next 60 T high completes a window of 10 + 60 = 70 T, all high -> duty 1.
    m.accumulate(1, 60); m.generateSamples(audio, null, false);
    expect(audio.samples.length).toBe(3);
    const y2 = ALPHA * (y1 + 0.8 - 0.8 * (10 / 70));
    expect(audio.samples[2]!.left).toBeCloseTo(y2, 12);
  });

  it('matches an exact per-sample integration of the same event stream', () => {
    // Feed instruction-sized calls (7..29 T) and compare against a second mixer fed
    // the exact duty of each 70 T window, computed T-state by T-state.
    const stream: number[] = [];
    const m = new AudioMixer(3_500_000);
    m.init(50_000);
    const audio = fakeAudio();
    for (let i = 0; i < 400; i++) {
      const el = 7 + (i * 5) % 23;
      const lvl = (i % 5) < 2 ? 1 : 0;
      for (let t = 0; t < el; t++) stream.push(lvl);
      m.accumulate(lvl, el);
      m.generateSamples(audio, null, false);
    }
    const ref = new AudioMixer(3_500_000);
    ref.init(50_000);
    const refAudio = fakeAudio();
    for (let pos = 0; pos + 70 <= stream.length; pos += 70) {
      let h = 0;
      for (let t = 0; t < 70; t++) h += stream[pos + t]!;
      ref.accumulateLevel(h / 70, 70);
      ref.generateSamples(refAudio, null, false);
    }
    const n = Math.min(audio.samples.length, refAudio.samples.length);
    expect(n).toBeGreaterThan(100);
    for (let i = 0; i < n; i++) expect(audio.samples[i]!.left).toBeCloseTo(refAudio.samples[i]!.left, 9);
  });

  it('falls back to proportional spreading when more is pending than one call explains', () => {
    const m = new AudioMixer(3_500_000);
    m.init(50_000);
    const audio = fakeAudio();
    m.accumulate(0, 70); m.generateSamples(audio, null, false);
    audio.samples.length = 0;
    m.accumulate(1, 70 * 3 + 10);                // one huge call: 3 windows + 10 T
    m.generateSamples(audio, null, false);
    expect(audio.samples.length).toBe(3);
    expect(audio.samples[0]!.left).toBeCloseTo(0.8 * ALPHA, 9);
  });
});

describe('AudioMixer — discardPending', () => {
  it('drops the beeper duty with the window, so the next sample is not normalised against a stale span', () => {
    const m = new AudioMixer(3_500_000);
    m.init(50_000);
    const audio = fakeAudio();
    m.accumulate(0, 70); m.generateSamples(audio, null, false);
    m.accumulate(1, 50);                         // pending high duty, not yet a sample
    m.discardPending();
    expect(m.beeperTStatesAccum).toBe(0);
    m.accumulate(0, 70); m.generateSamples(audio, null, false);
    expect(audio.samples[1]!.left).toBeCloseTo(0, 12);   // before the fix, duty 50/70 leaked in
  });
});

// ── Auxiliary DAC channel (SpecDrum) ───────────────────────────────────────
//
// The aux input is a SIGNED level (-1..+1, 0 = the DAC's idle code), scaled by 0.8, so a
// DAC at idle is exactly zero and needs no priming, seeding or fade-out.

describe('AudioMixer — auxiliary DAC channel', () => {
  const N = 70;                                          // T per sample at 50 kHz, exactly
  const ALPHA = 1 - (2 * Math.PI * 20 / 50_000);
  const AUX = 0.8;                                       // amplitude at a signed level of 1

  const mk = () => { const m = new AudioMixer(3_500_000); m.init(50_000); return m; };
  function feed(m: AudioMixer, audio: ReturnType<typeof fakeAudio>, level: number, elapsed = N): void {
    m.accumulate(0, elapsed);
    m.accumulateAux(level, elapsed);
    m.generateSamples(audio, null, false);
  }

  it('a step to level L gives L * 0.8 * alpha, then decays by alpha per sample (high-pass)', () => {
    const m = mk(); const audio = fakeAudio();
    for (let i = 0; i < 4; i++) feed(m, audio, 0.5);
    expect(audio.samples.length).toBe(4);
    for (let n = 0; n < 4; n++) {
      expect(audio.samples[n]!.left).toBeCloseTo(0.5 * AUX * Math.pow(ALPHA, n + 1), 9);
      expect(audio.samples[n]!.right).toBeCloseTo(audio.samples[n]!.left, 12); // mono, centred
    }
  });

  it('an idle DAC (level 0) is exactly silent, from the very first sample', () => {
    const m = mk(); const audio = fakeAudio();
    for (let i = 0; i < 30; i++) feed(m, audio, 0);
    expect(audio.samples.length).toBe(30);
    for (const s of audio.samples) expect(s.left).toBe(0);
  });

  it('is signed: a negative level swings the speaker the other way', () => {
    const m = mk(); const audio = fakeAudio();
    feed(m, audio, -0.5);
    expect(audio.samples[0]!.left).toBeCloseTo(-0.5 * AUX * ALPHA, 12);
  });

  it('switching on mid-window at idle is exact: nothing was missed, so nothing steps', () => {
    const m = mk(); const audio = fakeAudio();
    m.accumulate(0, 50); m.generateSamples(audio, null, false);          // 50 T of window, no aux yet
    m.accumulateLevel(0, 20); m.accumulateAux(0, 20);                    // aux switched on for the last 20 T, at idle
    m.generateSamples(audio, null, false);
    for (let i = 0; i < 5; i++) feed(m, audio, 0);
    for (const s of audio.samples) expect(s.left).toBe(0);
  });

  it('a DC level the software parks the DAC at is filtered off (decays, no hum)', () => {
    const m = mk(); const audio = fakeAudio();
    for (let i = 0; i < 1000; i++) feed(m, audio, 0.5);
    const first = audio.samples[0]!.left, last = audio.samples[999]!.left;
    expect(first).toBeGreaterThan(0.39);
    expect(Math.abs(last)).toBeLessThan(first / 10);                     // alpha^1000 ~ 0.08
  });

  it('time-weights a level that changes mid-window (half idle, half at 0.5 gives mean 0.25)', () => {
    const m = mk(); const audio = fakeAudio();
    m.accumulate(0, 35); m.accumulateAux(0, 35);
    m.accumulate(0, 35); m.accumulateAux(0.5, 35);
    m.generateSamples(audio, null, false);
    expect(audio.samples[0]!.left).toBeCloseTo(ALPHA * 0.25 * AUX, 9);
  });

  it('cuts at the sample boundary like the beeper (10 T of a 20 T instruction land in this sample)', () => {
    const m = mk(); const audio = fakeAudio();
    m.accumulate(0, 60); m.accumulateAux(0, 60); m.generateSamples(audio, null, false);
    m.accumulate(0, 20); m.accumulateAux(1, 20); m.generateSamples(audio, null, false);
    expect(audio.samples[0]!.left).toBeCloseTo(ALPHA * AUX * (10 / 70), 9);
  });

  it('auxGain scales it and clamps to 0..2 (the DAC may exceed the speaker); 0 is silent', () => {
    const run = (gain: number) => {
      const m = mk(); m.auxGain = gain;
      const audio = fakeAudio();
      feed(m, audio, 0.25);
      return audio.samples[0]!.left;
    };
    expect(run(0.5)).toBeCloseTo(0.5 * 0.25 * AUX * ALPHA, 9);
    expect(run(2)).toBeCloseTo(2 * 0.25 * AUX * ALPHA, 9);   // above 1 is allowed
    expect(run(0)).toBe(0);
    expect(run(-3)).toBe(0);
    const m = mk(); m.auxGain = 7;
    expect(m.auxGain).toBe(2);
  });

  it('is independent of the beeper and PSG gains', () => {
    const m = mk(); m.beeperGain = 0; m.ayGain = 0; m.auxGain = 0.25;
    const audio = fakeAudio();
    feed(m, audio, 0.5);
    expect(audio.samples[0]!.left).toBeCloseTo(0.25 * 0.5 * AUX * ALPHA, 9);
  });

  it('adds to the beeper rather than replacing it', () => {
    const only = (beeper: number, aux: number) => {
      const m = mk(); m.auxGain = 0.5;
      const audio = fakeAudio();
      m.accumulateLevel(0, N); m.accumulateAux(0, N); m.generateSamples(audio, null, false);   // beeper filter primes here
      m.accumulateLevel(beeper, N); m.accumulateAux(aux, N); m.generateSamples(audio, null, false);
      return audio.samples[1]!.left;
    };
    expect(only(0.4, 0.3)).toBeCloseTo(only(0.4, 0) + only(0, 0.3), 12);
    expect(only(0.4, 0.3)).toBeGreaterThan(only(0.4, 0));
  });

  it('a mixer that never used the aux channel is bit-identical whatever its gain', () => {
    const play = (gain: number) => {
      const m = mk(); m.auxGain = gain;
      const audio = fakeAudio();
      for (let i = 0; i < 50; i++) {
        m.accumulate(i % 3 === 0 ? 1 : 0, 37 + i);
        m.generateSamples(audio, fakeAY(0.2, 0.1), true);
      }
      return audio.samples;
    };
    expect(play(0.3)).toEqual(play(1));
  });

  it('discardPending drops the aux duty too (turbo path)', () => {
    const m = mk(); const audio = fakeAudio();
    feed(m, audio, 0);
    m.accumulate(0, 50); m.accumulateAux(1, 50);
    m.discardPending();
    feed(m, audio, 0);
    expect(audio.samples[1]!.left).toBeCloseTo(0, 12);
  });

  it('reset() clears the filter and goes dormant: nothing rings on afterwards', () => {
    const m = mk(); const audio = fakeAudio();
    feed(m, audio, 0.5); feed(m, audio, 0.5);
    expect(audio.samples[1]!.left).toBeGreaterThan(0.3);
    m.reset();
    audio.samples.length = 0;
    m.accumulate(0, N); m.generateSamples(audio, null, false);           // aux no longer fed
    feed(m, audio, 0);
    for (const s of audio.samples) expect(s.left).toBe(0);
  });
});

describe('AudioMixer — mono peripheral source (speech board)', () => {
  const N = 70;                                          // T per sample at 50 kHz, exactly
  const mk = () => { const m = new AudioMixer(3_500_000); m.init(50_000); return m; };
  /** A speech source already level-set at a steady 0.25. */
  const speech = { generateSampleMono: () => 0.25 };
  function render(gain: number | null): number {
    const m = mk(); const audio = fakeAudio();
    if (gain !== null) m.monoGain = gain;
    m.beeperGain = 0;                                    // isolate the mono source
    m.accumulate(0, N);
    m.generateSamples(audio, null, false, speech);
    return audio.samples[0]!.left;
  }

  it('is mixed at unity by default, equally into both channels', () => {
    const m = mk(); const audio = fakeAudio();
    m.accumulate(0, N); m.generateSamples(audio, null, false, speech);
    expect(audio.samples[0]).toEqual({ left: 0.25, right: 0.25 });
  });

  it('monoGain scales it linearly', () => {
    expect(render(0.5)).toBeCloseTo(0.125, 12);
    expect(render(1.5)).toBeCloseTo(0.375, 12);
  });

  it('monoGain 0 silences it', () => {
    expect(render(0)).toBe(0);
  });

  it('monoGain clamps to 0..2 so a stray setting cannot blow the output up', () => {
    const m = mk();
    m.monoGain = 9; expect(m.monoGain).toBe(2);
    m.monoGain = -3; expect(m.monoGain).toBe(0);
  });

  it('does not touch the beeper or the PSG: only the mono source is scaled', () => {
    const m = mk(); const audio = fakeAudio();
    m.monoGain = 0;
    m.beeperGain = 1;
    m.accumulateLevel(1, N);                             // beeper held high: first sample steps up through the DC-blocker
    m.generateSamples(audio, null, false, speech);
    const withoutSpeech = mk(); const a2 = fakeAudio();
    withoutSpeech.accumulateLevel(1, N); withoutSpeech.generateSamples(a2, null, false);
    expect(audio.samples[0]!.left).toBe(a2.samples[0]!.left);
  });
});
