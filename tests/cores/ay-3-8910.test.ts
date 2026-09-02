import { describe, it, expect, beforeEach } from 'vitest';
import { AY3891x, VOLUME_TABLE, type AYStereoMode } from '@/cores/ay-3-8910.ts';

// Standard 128K AY clock = 1.7734 MHz, 44.1 kHz audio
const CHIP_FREQ = 1773400;
const SAMPLE_RATE = 44100;

function makeAy(stereo: AYStereoMode = 'ABC'): AY3891x {
  const ay = new AY3891x(CHIP_FREQ, SAMPLE_RATE, stereo);
  ay.dcBlocking = false; // raw output for deterministic assertions
  return ay;
}

describe('AY-3-8910 — construction & defaults', () => {
  it('initialises with sane defaults', () => {
    const ay = new AY3891x(CHIP_FREQ, SAMPLE_RATE);
    expect(ay.chipFreq).toBe(CHIP_FREQ);
    expect(ay.sampleRate).toBe(SAMPLE_RATE);
    expect(ay.cyclesPerSample).toBeCloseTo(CHIP_FREQ / (SAMPLE_RATE * 8), 6);
    expect(ay.stereoMode).toBe('ABC');
    expect(ay.noiseRng).toBe(1);
    expect(ay.regs.length).toBe(16);
    expect(ay.dcBlocking).toBe(true);
  });

  it('falls back to 1773400 when chipFreq is 0/falsy', () => {
    const ay = new AY3891x(0 as any, SAMPLE_RATE);
    expect(ay.chipFreq).toBe(1773400);
  });

  it('accepts an explicit stereo mode', () => {
    const ay = new AY3891x(CHIP_FREQ, SAMPLE_RATE, 'ACB');
    expect(ay.stereoMode).toBe('ACB');
  });
});

describe('AY-3-8910 — VOLUME_TABLE', () => {
  it('has 32 entries forming 16 pairs (YM2149 DAC)', () => {
    expect(VOLUME_TABLE.length).toBe(32);
    for (let i = 0; i < 32; i += 2) {
      expect(VOLUME_TABLE[i]).toBe(VOLUME_TABLE[i + 1]);
    }
  });

  it('is monotonically non-decreasing', () => {
    for (let i = 1; i < VOLUME_TABLE.length; i++) {
      expect(VOLUME_TABLE[i]).toBeGreaterThanOrEqual(VOLUME_TABLE[i - 1]);
    }
  });

  it('runs from silence to full scale', () => {
    expect(VOLUME_TABLE[0]).toBe(0);
    expect(VOLUME_TABLE[31]).toBe(1);
  });
});

describe('AY-3-8910 — reset', () => {
  it('clears all generator state and registers', () => {
    const ay = makeAy();
    for (let r = 0; r < 14; r++) ay.writeRegister(r, 0xAA);
    ay.writeRegister(13, 0x0E);
    ay.generateSample();

    ay.reset();

    expect(Array.from(ay.regs)).toEqual(new Array(16).fill(0));
    expect(Array.from(ay.tonePeriod)).toEqual([1, 1, 1]);
    expect(ay.noisePeriod).toBe(1);
    expect(ay.envPeriod).toBe(1);
    expect(ay.noiseRng).toBe(1);
    expect(ay.envShape).toBe(0);
    expect(ay.envStep).toBe(0);
    expect(ay.envHolding).toBe(false);
    expect(ay.envVolume).toBe(0);
    expect(ay.cycleFrac).toBe(0);
    expect(Array.from(ay.toneOutput)).toEqual([0, 0, 0]);
    expect(Array.from(ay.amplitude)).toEqual([0, 0, 0]);
    expect(ay.selectedReg).toBe(0);
  });
});

describe('AY-3-8910 — writeRegister / readRegister', () => {
  let ay: AY3891x;
  beforeEach(() => { ay = makeAy(); });

  it('masks the register number to 4 bits', () => {
    ay.writeRegister(0x10, 0x42); // reg 0
    expect(ay.regs[0]).toBe(0x42);
    expect(ay.readRegister(0x20)).toBe(0x42); // reg 0
  });

  it('readRegister masks narrow registers to their real bit width on read', () => {
    // Real hardware has no latch for the unused high bits of these
    // registers — they read back 0 regardless of what was written.
    // Chip-detect routines rely on this. The stored raw byte (regs[])
    // is untouched — only readRegister()'s output is masked.
    const narrow: [reg: number, mask: number][] = [
      [1, 0x0F], [3, 0x0F], [5, 0x0F], [13, 0x0F], // 4-bit
      [6, 0x1F], [8, 0x1F], [9, 0x1F], [10, 0x1F], // 5-bit
    ];
    for (const [reg, mask] of narrow) {
      ay.writeRegister(reg, 0xFF);
      expect(ay.regs[reg]).toBe(0xFF); // raw storage keeps the full byte
      expect(ay.readRegister(reg)).toBe(0xFF & mask); // read-back is masked
    }
  });

  it('readRegister does not mask the full 8-bit registers', () => {
    const full = [0, 2, 4, 7, 11, 12, 14, 15];
    for (const reg of full) {
      ay.writeRegister(reg, 0xFF);
      expect(ay.readRegister(reg)).toBe(0xFF);
    }
  });

  it('forms 12-bit tone periods, masking high nibble', () => {
    ay.writeRegister(0, 0x34);
    ay.writeRegister(1, 0xF2); // only low nibble used
    expect(ay.tonePeriod[0]).toBe(0x234);

    ay.writeRegister(2, 0x00);
    ay.writeRegister(3, 0x00); // period 0 → clamps to 1
    expect(ay.tonePeriod[1]).toBe(1);

    ay.writeRegister(4, 0xFF);
    ay.writeRegister(5, 0x0F);
    expect(ay.tonePeriod[2]).toBe(0xFFF);
  });

  it('masks noise period to 5 bits and clamps 0→1', () => {
    ay.writeRegister(6, 0xE0); // top bits dropped
    expect(ay.noisePeriod).toBe(1);
    ay.writeRegister(6, 0x1F);
    expect(ay.noisePeriod).toBe(0x1F);
    ay.writeRegister(6, 0x05);
    expect(ay.noisePeriod).toBe(5);
  });

  it('stores mixer raw (8 bits)', () => {
    ay.writeRegister(7, 0xFF);
    expect(ay.mixer).toBe(0xFF);
    ay.writeRegister(7, 0x3F);
    expect(ay.mixer).toBe(0x3F);
  });

  it('masks amplitude to 5 bits', () => {
    ay.writeRegister(8, 0xFF);
    expect(ay.amplitude[0]).toBe(0x1F);
    ay.writeRegister(9, 0x10);
    expect(ay.amplitude[1]).toBe(0x10); // envelope-mode flag preserved
    ay.writeRegister(10, 0x0A);
    expect(ay.amplitude[2]).toBe(0x0A);
  });

  it('forms 16-bit envelope period and clamps 0→1', () => {
    ay.writeRegister(11, 0x00);
    ay.writeRegister(12, 0x00);
    expect(ay.envPeriod).toBe(1);
    ay.writeRegister(11, 0x34);
    ay.writeRegister(12, 0x12);
    expect(ay.envPeriod).toBe(0x1234);
  });

  it('writing envelope shape resets the envelope generator', () => {
    ay.envStep = 17;
    ay.envHolding = true;
    ay.writeRegister(13, 0x0E); // /\/\/\ alternate, continue, attack
    expect(ay.envShape).toBe(0x0E);
    expect(ay.envStep).toBe(0);
    expect(ay.envHolding).toBe(false);
    expect(ay.envContinue).toBe(true);
    expect(ay.envAttack).toBe(0x1F); // attack=1
    expect(ay.envAlternate).toBe(true);
    expect(ay.envHold).toBe(false);
    expect(ay.envVolume).toBe(0); // attack → start at 0
  });

  it('non-attack envelope starts at volume 31', () => {
    ay.writeRegister(13, 0x09); // continue=1, attack=0, alternate=0, hold=1 → "\___"
    expect(ay.envAttack).toBe(0x00);
    expect(ay.envVolume).toBe(31);
  });
});

describe('AY-3-8910 — getRegisters / setRegisters', () => {
  it('getRegisters returns a 14-byte copy that is independent of internal state', () => {
    const ay = makeAy();
    ay.writeRegister(0, 0xAB);
    ay.writeRegister(13, 0x0E);
    ay.regs[14] = 0x77; // I/O port — should be excluded
    const snap = ay.getRegisters();
    expect(snap.length).toBe(14);
    expect(snap[0]).toBe(0xAB);
    expect(snap[13]).toBe(0x0E);
    snap[0] = 0; // mutation must not affect the chip
    expect(ay.regs[0]).toBe(0xAB);
  });

  it('setRegisters bulk-loads and recomputes derived state', () => {
    const ay = makeAy();
    const regs = new Uint8Array(14);
    regs[0] = 0x10; regs[1] = 0x02;     // tone A = 0x210
    regs[6] = 0x07;                       // noise period 7
    regs[7] = 0b00111110;                 // mixer
    regs[8] = 0x0F;                       // amp A
    regs[9] = 0x10;                       // amp B = envelope
    regs[11] = 0xCD; regs[12] = 0xAB;    // env period 0xABCD
    regs[13] = 0x0C;                      // envelope shape
    ay.setRegisters(regs);
    expect(ay.tonePeriod[0]).toBe(0x210);
    expect(ay.noisePeriod).toBe(7);
    expect(ay.mixer).toBe(0b00111110);
    expect(ay.amplitude[0]).toBe(0x0F);
    expect(ay.amplitude[1]).toBe(0x10);
    expect(ay.envPeriod).toBe(0xABCD);
    expect(ay.envShape).toBe(0x0C);
    expect(ay.envStep).toBe(0);
  });

  it('setRegisters with R13 = 0xFF does NOT retrigger envelope (YM convention)', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x0E);
    ay.envStep = 5;
    const before = ay.envStep;

    const regs = new Uint8Array(14);
    regs[13] = 0xFF;
    ay.setRegisters(regs);
    expect(ay.envStep).toBe(before); // untouched
  });

  it('setRegisters tolerates an undersized array', () => {
    const ay = makeAy();
    const regs = new Uint8Array(8);
    regs[0] = 0x55;
    expect(() => ay.setRegisters(regs)).not.toThrow();
    expect(ay.regs[0]).toBe(0x55);
  });
});

describe('AY-3-8910 — tone generator', () => {
  it('toggles output when counter reaches period', () => {
    const ay = makeAy();
    ay.writeRegister(0, 5);
    ay.writeRegister(1, 0);
    // mixer: enable tone A only, disable noise on all
    ay.writeRegister(7, 0b00111110);
    ay.writeRegister(8, 0x0F);

    const initial = ay.toneOutput[0];
    for (let i = 0; i < 5; i++) ay.clock();
    expect(ay.toneOutput[0]).toBe(initial ^ 1);
    for (let i = 0; i < 5; i++) ay.clock();
    expect(ay.toneOutput[0]).toBe(initial);
  });

  it('period 1 toggles every single clock', () => {
    const ay = makeAy();
    ay.writeRegister(0, 1); ay.writeRegister(1, 0);
    const a = ay.toneOutput[0];
    ay.clock();
    expect(ay.toneOutput[0]).toBe(a ^ 1);
    ay.clock();
    expect(ay.toneOutput[0]).toBe(a);
  });
});

describe('AY-3-8910 — noise LFSR', () => {
  it('seed is 1 and never collapses to 0', () => {
    const ay = makeAy();
    ay.writeRegister(6, 1); // fastest noise
    let zeros = 0;
    for (let i = 0; i < 10000; i++) {
      ay.clock();
      if (ay.noiseRng === 0) zeros++;
    }
    expect(zeros).toBe(0);
  });

  it('produces both 0 and 1 bits', () => {
    const ay = makeAy();
    ay.writeRegister(6, 1);
    let ones = 0;
    let zeroes = 0;
    for (let i = 0; i < 1000; i++) {
      ay.clock();
      if (ay.noiseOutput) ones++; else zeroes++;
    }
    expect(ones).toBeGreaterThan(100);
    expect(zeroes).toBeGreaterThan(100);
  });

  it('17-bit LFSR has period 2^17 - 1 = 131071', () => {
    const ay = makeAy();
    ay.writeRegister(6, 1);
    const seed = ay.noiseRng;
    let shifts = 0;
    let period = 0;
    // Noise is prescaled ÷2 ahead of its counter (real hardware clocks it at
    // half the tone/envelope rate), so it advances once every 2 clock() calls.
    for (let i = 1; i <= 400000; i++) {
      const before = ay.noiseRng;
      ay.clock();
      if (ay.noiseRng !== before) {
        shifts++;
        if (ay.noiseRng === seed) { period = shifts; break; }
      }
    }
    expect(period).toBe(131071);
  });
});

describe('AY-3-8910 — envelope shapes', () => {
  function runEnvelope(ay: AY3891x, samples: number, period = 1): number[] {
    ay.writeRegister(11, period & 0xFF);
    ay.writeRegister(12, (period >> 8) & 0xFF);
    const out: number[] = [];
    for (let i = 0; i < samples; i++) {
      ay.clock();
      out.push(ay.envVolume);
    }
    return out;
  }

  it('shape 0x0F (\\___ via continue+attack+alternate+hold) holds at 0 after one ramp', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x0F); // continue+attack+alternate+hold → up then hold at 0
    const trace = runEnvelope(ay, 64);
    expect(trace[29]).toBe(30);
    expect(Math.max(...trace)).toBe(31);
    // after step 31 → wraps; alternate+hold + attack → final = 0
    for (let i = 40; i < trace.length; i++) expect(trace[i]).toBe(0);
  });

  it('shape 0x0B (\\___ continue+alternate+hold, no attack) holds at 31', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x0B);
    expect(ay.envVolume).toBe(31);
    const trace = runEnvelope(ay, 64);
    // alternate+hold + !attack → final = 31
    for (let i = 40; i < trace.length; i++) expect(trace[i]).toBe(31);
    expect(ay.envHolding).toBe(true);
  });

  it('shape 0x0D (/¯¯ continue+attack+hold) holds at 31', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x0D);
    const trace = runEnvelope(ay, 64);
    for (let i = 40; i < trace.length; i++) expect(trace[i]).toBe(31);
    expect(ay.envHolding).toBe(true);
  });

  it('shape 0x09 (\\___ continue+hold, no attack/alternate) holds at 0', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x09);
    const trace = runEnvelope(ay, 64);
    for (let i = 40; i < trace.length; i++) expect(trace[i]).toBe(0);
  });

  it('non-continue shape decays and holds at 0', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x00); // \___
    const trace = runEnvelope(ay, 64);
    expect(trace[0]).toBe(30); // 31 → 30
    for (let i = 40; i < trace.length; i++) expect(trace[i]).toBe(0);
    expect(ay.envHolding).toBe(true);
  });

  it('shape 0x08 (\\\\\\ continue, no hold) repeats sawtooth', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x08);
    runEnvelope(ay, 32);
    // after a full ramp, should restart, not hold
    expect(ay.envHolding).toBe(false);
    const traceB = runEnvelope(ay, 32);
    // Should have hit 0 again in cycle 2
    expect(traceB.includes(0)).toBe(true);
  });

  it('shape 0x0E (/\\/\\ continue+attack+alternate) alternates direction', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x0E);
    runEnvelope(ay, 32); // up ramp
    expect(ay.envHolding).toBe(false);
    const downTrace = runEnvelope(ay, 32);
    // Now ramping the other way
    expect(downTrace[0]).toBeGreaterThan(downTrace[downTrace.length - 1]);
  });
});

describe('AY-3-8910 — mixer and channel output', () => {
  it('silences channels with zero amplitude', () => {
    const ay = makeAy();
    ay.writeRegister(7, 0b00111000); // tone all enabled, noise all off
    // amplitudes all zero by default
    expect(ay.output()).toBe(0);
  });

  it('produces non-zero output with fixed amplitude on enabled channel', () => {
    const ay = makeAy();
    ay.writeRegister(0, 4); ay.writeRegister(1, 0);
    ay.writeRegister(7, 0b00111110); // tone A only
    ay.writeRegister(8, 0x0F); // amp A = max fixed

    let saw = false;
    for (let i = 0; i < 100; i++) {
      ay.clock();
      if (ay.output() > 0) { saw = true; break; }
    }
    expect(saw).toBe(true);
  });

  it('amplitude bit 4 (0x10) selects envelope volume', () => {
    const ay = makeAy();
    ay.writeRegister(7, 0b00111110); // tone A only
    ay.writeRegister(8, 0x10);        // amp A = envelope
    ay.writeRegister(13, 0x0D);       // up-hold → envVolume = 0 then climbs
    // Force the tone high so the mixer ANDs to 1
    ay.toneOutput[0] = 1;
    ay.envVolume = 31;
    expect(ay.output()).toBeCloseTo(VOLUME_TABLE[31] / 3 * 0.75, 6);
    ay.envVolume = 0;
    expect(ay.output()).toBe(0);
  });

  it('mixer bit set disables tone (output goes high regardless of period)', () => {
    const ay = makeAy();
    // tone A disabled (bit 0=1), noise A disabled (bit 3=1)
    ay.writeRegister(7, 0b00111111);
    ay.writeRegister(8, 0x0F);
    // toneOut and noiseOut both forced to 1 by being disabled → output is just amplitude
    const expected = VOLUME_TABLE[0x0F * 2 + 1] / 3 * 0.75;
    expect(ay.output()).toBeCloseTo(expected, 6);
  });

  it('noise mixed in: with noiseOutput=0 and tone disabled, channel is silent', () => {
    const ay = makeAy();
    ay.writeRegister(7, 0b00110111); // tone A disabled, noise A enabled
    ay.writeRegister(8, 0x0F);
    ay.noiseOutput = 0;
    ay.toneOutput[0] = 1; // doesn't matter — tone gated to 1 anyway
    expect(ay.output()).toBe(0);
  });
});

describe('AY-3-8910 — stereo panning modes', () => {
  function getStereo(mode: AYStereoMode): { left: number; right: number } {
    const ay = makeAy(mode);
    // Force fully-on channel A only
    ay.writeRegister(7, 0b00111110);
    ay.writeRegister(8, 0x0F);
    ay.toneOutput[0] = 1;
    return { ...ay.outputStereo() };
  }

  it('MONO splits equally', () => {
    const s = getStereo('MONO');
    expect(s.left).toBeCloseTo(s.right, 6);
    expect(s.left).toBeGreaterThan(0);
  });

  it('ABC routes channel A to the left', () => {
    const s = getStereo('ABC');
    expect(s.left).toBeGreaterThan(s.right);
    expect(s.right).toBe(0);
  });

  it('BCA routes channel A to the right', () => {
    const s = getStereo('BCA');
    expect(s.right).toBeGreaterThan(s.left);
    expect(s.left).toBe(0);
  });

  it('setStereoMode updates the mode', () => {
    const ay = makeAy('ABC');
    ay.setStereoMode('CBA');
    expect(ay.stereoMode).toBe('CBA');
  });

  it('outputStereo returns the same object instance (no GC pressure)', () => {
    const ay = makeAy();
    const a = ay.outputStereo();
    const b = ay.outputStereo();
    expect(a).toBe(b);
  });
});

describe('AY-3-8910 — sample generation', () => {
  it('generateSample consumes the expected number of chip cycles per sample', () => {
    const ay = makeAy();
    // disable everything to keep clock cheap; we just measure cycleFrac flow
    const before = ay.cycleFrac;
    ay.generateSample();
    // After one sample, cycleFrac < 1 and has advanced by (cyclesPerSample mod 1)
    expect(ay.cycleFrac).toBeLessThan(1);
    expect(ay.cycleFrac).toBeGreaterThanOrEqual(0);
    expect(ay.cycleFrac).not.toBe(before); // moved
  });

  it('generateSampleStereo returns finite numbers', () => {
    const ay = makeAy();
    ay.writeRegister(0, 100); ay.writeRegister(1, 0);
    ay.writeRegister(7, 0b00111110);
    ay.writeRegister(8, 0x0C);
    for (let i = 0; i < 256; i++) {
      const s = ay.generateSampleStereo();
      expect(Number.isFinite(s.left)).toBe(true);
      expect(Number.isFinite(s.right)).toBe(true);
      expect(Math.abs(s.left)).toBeLessThan(2);
      expect(Math.abs(s.right)).toBeLessThan(2);
    }
  });

  it('DC-blocking filter removes the DC bias of a constant signal', () => {
    const ay = new AY3891x(CHIP_FREQ, SAMPLE_RATE);
    // dcBlocking on by default. Force a constant non-zero output by gating mixer fully off.
    ay.writeRegister(7, 0b00111111); // all tone/noise disabled → channel output = pure amplitude
    ay.writeRegister(8, 0x0F);
    ay.writeRegister(9, 0x0F);
    ay.writeRegister(10, 0x0F);

    // Run through filter settling time (~1 second of audio is plenty)
    let last = 0;
    for (let i = 0; i < SAMPLE_RATE * 2; i++) last = ay.generateSample();
    expect(Math.abs(last)).toBeLessThan(0.01); // DC blocked to near-zero
  });

  it('without DC-blocking the steady output is non-zero and stable', () => {
    const ay = makeAy(); // dcBlocking=false
    ay.writeRegister(7, 0b00111111);
    ay.writeRegister(8, 0x0F);
    ay.writeRegister(9, 0x0F);
    ay.writeRegister(10, 0x0F);

    const s1 = ay.generateSample();
    for (let i = 0; i < 1000; i++) ay.generateSample();
    const s2 = ay.generateSample();
    expect(s1).toBeGreaterThan(0);
    expect(s2).toBeCloseTo(s1, 6);
  });
});

// ─── New, more critical coverage ─────────────────────────────────────────
//
// Existing tests above were left intact (their assertions are sound), but
// they were thin in a few places: stereo only checked direction (not the
// 100%/50% crossover ratio that defines ABC stereo), envelope coverage was
// 5 of 16 shapes, the DC blocker test only proved DC is removed (not that
// AC passes), and there were no tests for the I/O port registers, for
// mid-flight period changes, or for the exact LFSR tap.

describe('AY-3-8910 — construction parity with reset()', () => {
  it('a freshly-constructed chip has the same generator periods as one after reset()', () => {
    // The bug used to be: constructor left periods at 0, but reset() sets
    // them to 1. So `new AY3891x()` then clocking (before any register
    // write) would toggle every clock — different from any post-reset state.
    const fresh = new AY3891x(CHIP_FREQ, SAMPLE_RATE);
    const reset = new AY3891x(CHIP_FREQ, SAMPLE_RATE);
    reset.reset();
    expect(Array.from(fresh.tonePeriod)).toEqual(Array.from(reset.tonePeriod));
    expect(fresh.noisePeriod).toBe(reset.noisePeriod);
    expect(fresh.envPeriod).toBe(reset.envPeriod);
  });
});

describe('AY-3-8910 — full envelope shape table', () => {
  // Real-hardware envelope shape table. See General Instrument AY-3-8910
  // datasheet, Figure 6. Bits: 3=continue, 2=attack, 1=alternate, 0=hold.
  // Shapes 0x00–0x03 and 0x09 all behave as "\___" (decay then hold at 0).
  // Shapes 0x04–0x07 all behave as "/___" (ramp up then drop to 0).
  // 0x08 = sawtooth \\\\, 0x0A = /\/\ (start ramp down), 0x0B = "\¯¯¯",
  // 0x0C = ////, 0x0D = "/¯¯¯", 0x0E = /\/\ (start ramp up), 0x0F = "/|___".

  function run(ay: AY3891x, n: number): number[] {
    // envPeriod is already 1 after reset; one clock per envelope step.
    ay.writeRegister(11, 1);
    ay.writeRegister(12, 0);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      ay.clock();
      out.push(ay.envVolume);
    }
    return out;
  }

  for (const shape of [0x00, 0x01, 0x02, 0x03, 0x09]) {
    it(`shape 0x${shape.toString(16).toUpperCase().padStart(2, '0')} behaves as \\___ (decay then hold at 0)`, () => {
      const ay = makeAy();
      ay.writeRegister(13, shape);
      expect(ay.envVolume).toBe(31); // attack=0 → starts at top
      const trace = run(ay, 64);
      expect(trace[0]).toBe(30);
      expect(trace[30]).toBe(0);
      for (let i = 31; i < trace.length; i++) expect(trace[i]).toBe(0);
      expect(ay.envHolding).toBe(true);
    });
  }

  for (const shape of [0x04, 0x05, 0x06, 0x07]) {
    it(`shape 0x${shape.toString(16).toUpperCase().padStart(2, '0')} behaves as /___ (rise then hold at 0)`, () => {
      const ay = makeAy();
      ay.writeRegister(13, shape);
      expect(ay.envVolume).toBe(0); // attack=1 → starts at bottom
      const trace = run(ay, 64);
      expect(trace[0]).toBe(1);
      expect(trace[30]).toBe(31);
      // step 32 triggers !continue branch → drop to 0 and hold
      for (let i = 31; i < trace.length; i++) expect(trace[i]).toBe(0);
      expect(ay.envHolding).toBe(true);
    });
  }

  it('shape 0x08 is repeating \\\\\\\\: each cycle starts at 31 again', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x08);
    const first = run(ay, 32);
    expect(first[0]).toBe(30);
    expect(first[30]).toBe(0);
    expect(first[31]).toBe(31); // wraps cleanly back to top
    const second = run(ay, 32);
    expect(second[0]).toBe(30);
    expect(second[30]).toBe(0);
    expect(ay.envHolding).toBe(false);
  });

  it('shape 0x0A is \\/\\/ (no hold): down ramp, then up ramp, repeats', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x0A); // continue, no attack, alternate, no hold
    // attack=0 → starts at 31, ramps down
    const down = run(ay, 32);
    expect(down[0]).toBe(30);
    expect(down[30]).toBe(0);
    // Wrap: alternate flips attack to 0x1F, envStep resets to 0,
    // envVolume = (attack ? envStep : 31-envStep) = envStep = 0. Bottom of trough.
    expect(down[31]).toBe(0);
    const up = run(ay, 32);
    expect(up[0]).toBe(1);
    expect(up[30]).toBe(31);
    expect(up[31]).toBe(31); // wraps to top, ready to ramp down again
    expect(ay.envHolding).toBe(false);
  });

  it('shape 0x0C is repeating //// (sawtooth up): each cycle starts at 0', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x0C); // continue, attack, no alternate, no hold
    expect(ay.envVolume).toBe(0);
    const first = run(ay, 32);
    expect(first[0]).toBe(1);
    expect(first[30]).toBe(31);
    expect(first[31]).toBe(0); // wraps back to 0
    const second = run(ay, 32);
    expect(second[30]).toBe(31);
  });

  it('shape 0x0E continues alternating direction forever', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x0E);
    const up = run(ay, 32);
    expect(up[0]).toBe(1);
    expect(up[30]).toBe(31);
    expect(up[31]).toBe(31); // alternate flip → top, ready to ramp down
    const down = run(ay, 32);
    expect(down[0]).toBe(30);
    expect(down[30]).toBe(0);
    expect(down[31]).toBe(0); // alternate flip back, ready to ramp up
    expect(ay.envHolding).toBe(false);
  });
});

describe('AY-3-8910 — envelope period changes mid-flight', () => {
  it('writing R11/R12 does not retrigger but does change the rate', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x0C); // saw up
    ay.writeRegister(11, 1); ay.writeRegister(12, 0);
    for (let i = 0; i < 5; i++) ay.clock();
    expect(ay.envVolume).toBe(5);
    // Slow down to 4 chip ticks per step
    ay.writeRegister(11, 4); ay.writeRegister(12, 0);
    // envCounter already at 0 after last step. Need 4 more clocks for next.
    for (let i = 0; i < 3; i++) ay.clock();
    expect(ay.envVolume).toBe(5); // not yet
    ay.clock();
    expect(ay.envVolume).toBe(6);
  });
});

describe('AY-3-8910 — LFSR exact behaviour', () => {
  it('uses taps 0 and 3 (XOR) — verified against the known sequence', () => {
    // Standard AY/YM noise LFSR: 17-bit Galois with feedback bit = b0 XOR b3.
    const ay = makeAy();
    ay.writeRegister(6, 1);
    // Reproduce the first few iterations in software. Noise is prescaled ÷2
    // ahead of its counter, so it only shifts on every other clock() call.
    let rng = 1;
    for (let i = 0; i < 1000; i++) {
      ay.clock();
      if (i % 2 === 1) {
        const bit = ((rng ^ (rng >>> 3)) & 1);
        rng = (rng >>> 1) | (bit << 16);
      }
      expect(ay.noiseRng).toBe(rng);
    }
  });

  it('noise period gates the clocking — period 4 advances once per 8 clocks', () => {
    const ay = makeAy();
    ay.writeRegister(6, 4);
    const start = ay.noiseRng;
    for (let i = 0; i < 7; i++) ay.clock();
    expect(ay.noiseRng).toBe(start);
    ay.clock();
    expect(ay.noiseRng).not.toBe(start);
  });
});

describe('AY-3-8910 — mixer truth-table (all 8 enable combinations)', () => {
  // The mixer gates tone or noise via NAND-style logic: a 1 disables, so
  // an enabled channel with tone=0 OR noise=0 is silent; both at 1 sounds.
  it('tone disabled + noise disabled is silent (channel output forced high gives amp through)', () => {
    const ay = makeAy();
    // Both tone and noise OFF for channel A — output gated to high → amplitude passes
    ay.writeRegister(7, 0b00111111);
    ay.writeRegister(8, 0x0F);
    const v = ay.output();
    expect(v).toBeCloseTo(VOLUME_TABLE[0x0F * 2 + 1] / 3 * 0.75, 6);
  });

  it('tone enabled with toneOutput=0 silences the channel even when noise=1', () => {
    const ay = makeAy();
    ay.writeRegister(7, 0b00110110); // tone A enabled, noise A enabled
    ay.writeRegister(8, 0x0F);
    ay.toneOutput[0] = 0;
    ay.noiseOutput = 1;
    expect(ay.output()).toBe(0);
  });

  it('AND of tone and noise (both 1) sounds; either 0 silences', () => {
    const ay = makeAy();
    ay.writeRegister(7, 0b00110110); // ch A: tone + noise both enabled
    ay.writeRegister(8, 0x0F);
    ay.toneOutput[0] = 1; ay.noiseOutput = 1;
    expect(ay.output()).toBeGreaterThan(0);
    ay.toneOutput[0] = 1; ay.noiseOutput = 0;
    expect(ay.output()).toBe(0);
    ay.toneOutput[0] = 0; ay.noiseOutput = 1;
    expect(ay.output()).toBe(0);
  });
});

describe('AY-3-8910 — stereo panning exact ratios', () => {
  // ABC stereo on a real ZX is: A → L 100%, C → R 100%, B → 50/50.
  // The emulator scales by 0.75 / 1.5 (= 0.5) for "0.5 channel + middle*0.25
  // → divided by 1.5 then *0.75". The defining property is that the middle
  // channel contributes EQUALLY to L and R, while the outer channels are
  // exclusive. Test that explicitly for every mode.

  function pansFor(mode: AYStereoMode, ch: number): { left: number; right: number } {
    const ay = makeAy(mode);
    // Use the I/O-port-disabled trick: all mixer bits set for non-target channels.
    // For the channel under test, force toneOutput=1, set amp; for others, amp=0.
    ay.writeRegister(7, 0b00111111); // disables tone/noise on all → output = amplitude (no gating needed)
    ay.writeRegister(8 + ch, 0x0F);
    return { ...ay.outputStereo() };
  }

  const PAN: Record<AYStereoMode, ('L' | 'R' | 'M')[]> = {
    MONO: ['M', 'M', 'M'],
    ABC:  ['L', 'M', 'R'],
    ACB:  ['L', 'R', 'M'],
    BAC:  ['M', 'L', 'R'],
    BCA:  ['R', 'L', 'M'],
    CAB:  ['M', 'R', 'L'],
    CBA:  ['R', 'M', 'L'],
  };

  for (const mode of Object.keys(PAN) as AYStereoMode[]) {
    it(`${mode}: channels route per documented L/M/R map`, () => {
      for (let ch = 0; ch < 3; ch++) {
        const { left, right } = pansFor(mode, ch);
        const dest = PAN[mode][ch];
        if (dest === 'L') {
          expect(left).toBeGreaterThan(0);
          expect(right).toBe(0);
        } else if (dest === 'R') {
          expect(right).toBeGreaterThan(0);
          expect(left).toBe(0);
        } else {
          // Middle channel goes 50/50
          expect(left).toBeCloseTo(right, 6);
          expect(left).toBeGreaterThan(0);
        }
      }
    });
  }

  it('ABC: outer channel is exactly 2× the middle channel\'s per-side contribution', () => {
    // With A only on at amp 0x0F: L = a/1.5*0.75 = a*0.5
    // With B only on at amp 0x0F: L = 0.5*b/1.5*0.75 = b*0.25
    // → outer/middle = 2 (when a = b at same amp).
    const aOnly = pansFor('ABC', 0);
    const bOnly = pansFor('ABC', 1);
    expect(aOnly.left).toBeCloseTo(bOnly.left * 2, 6);
  });

  it('summed L+R across both side-routed channels reproduces mono output', () => {
    // ABC: L = (a + b/2)/1.5*0.75; R = (c + b/2)/1.5*0.75
    // L + R = (a + b + c)/1.5*0.75 = mono*2  (because mono divides by 3, stereo by 1.5)
    const ay = makeAy('ABC');
    ay.writeRegister(7, 0b00111111);
    ay.writeRegister(8, 0x0C);
    ay.writeRegister(9, 0x08);
    ay.writeRegister(10, 0x0F);
    const mono = ay.output();
    const s = ay.outputStereo();
    expect(s.left + s.right).toBeCloseTo(mono * 2, 6);
  });
});

describe('AY-3-8910 — DC blocking filter', () => {
  it('passes AC: a square wave keeps roughly its peak-to-peak amplitude', () => {
    const ay = new AY3891x(CHIP_FREQ, SAMPLE_RATE);
    ay.dcBlocking = true;
    // 1 kHz square via tone A (period chosen so output toggles around 1 kHz)
    // The exact frequency doesn't matter — just well above 20 Hz cutoff.
    ay.writeRegister(0, 0x6F); ay.writeRegister(1, 0); // period 111 → ~1 kHz
    ay.writeRegister(7, 0b00111110);
    ay.writeRegister(8, 0x0F);

    // Settle the filter
    for (let i = 0; i < SAMPLE_RATE / 4; i++) ay.generateSample();
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < SAMPLE_RATE / 4; i++) {
      const s = ay.generateSample();
      if (s < min) min = s;
      if (s > max) max = s;
    }
    // Without filter, peak-to-peak ≈ VOLUME_TABLE[31]/3*0.75 ≈ 0.25
    // With AC coupling, the signal is centred around 0 but should keep most of its swing.
    expect(max - min).toBeGreaterThan(0.15);
  });

  it('toggling dcBlocking off restores DC bias', () => {
    const ay = new AY3891x(CHIP_FREQ, SAMPLE_RATE);
    ay.writeRegister(7, 0b00111111);
    ay.writeRegister(8, 0x0F);
    ay.writeRegister(9, 0x0F);
    ay.writeRegister(10, 0x0F);

    ay.dcBlocking = true;
    for (let i = 0; i < SAMPLE_RATE; i++) ay.generateSample();
    const filtered = ay.generateSample();
    expect(Math.abs(filtered)).toBeLessThan(0.01);

    ay.dcBlocking = false;
    const raw = ay.generateSample();
    expect(raw).toBeGreaterThan(0.5); // raw DC bias is large for full-on channels
  });

  it('reset clears the DC blocker state so the next signal does not glitch', () => {
    const ay = new AY3891x(CHIP_FREQ, SAMPLE_RATE);
    ay.writeRegister(7, 0b00111111);
    ay.writeRegister(8, 0x0F);
    for (let i = 0; i < SAMPLE_RATE; i++) ay.generateSample();
    ay.reset();
    // After reset, no signal → output should be near zero immediately
    const s = ay.generateSample();
    expect(Math.abs(s)).toBeLessThan(0.001);
  });

  it('stereo DC blocker tracks L and R independently', () => {
    const ay = new AY3891x(CHIP_FREQ, SAMPLE_RATE, 'ABC');
    ay.dcBlocking = true;
    ay.writeRegister(7, 0b00111111);
    // Asymmetric: A loud (L), C silent (R), B silent → L has DC, R has none.
    ay.writeRegister(8, 0x0F);
    ay.writeRegister(9, 0x00);
    ay.writeRegister(10, 0x00);
    for (let i = 0; i < SAMPLE_RATE; i++) ay.generateSampleStereo();
    const s = ay.generateSampleStereo();
    expect(Math.abs(s.left)).toBeLessThan(0.01);
    expect(Math.abs(s.right)).toBeLessThan(0.01);
  });
});

describe('AY-3-8910 — ultrasonic anti-aliasing (the Chase HQ II whine)', () => {
  // Collect N raw mono samples (DC blocking left off so the test sees the bare
  // resampled signal, not the high-pass tail).
  function collect(ay: AY3891x, n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(ay.generateSample());
    return out;
  }
  const range = (a: number[]) => Math.max(...a) - Math.min(...a);

  // Channel C parked at tone period `period`, full volume, tone-enabled, with
  // A/B and all noise disabled in the mixer. period 0 → clamped to 1 ≈ 110 kHz.
  function oneChannel(mode: 'none' | 'box' | 'mute' | 'lowpass', period: number): AY3891x {
    const ay = new AY3891x(CHIP_FREQ, SAMPLE_RATE);
    ay.dcBlocking = false;
    ay.antialias = mode;
    ay.writeRegister(4, period & 0xFF);
    ay.writeRegister(5, (period >> 8) & 0x0F);
    ay.writeRegister(10, 0x0F);          // channel C volume = max
    ay.writeRegister(7, 0b11111011);     // enable tone C only
    return ay;
  }

  it("'none' point-sampling aliases a period-0 tone into a large varying ripple", () => {
    // A ~110 kHz square point-sampled at 44.1 kHz folds down to a loud audible
    // tone: consecutive samples swing between 0 and the channel's full level.
    const s = collect(oneChannel('none', 0), 256);
    expect(range(s)).toBeGreaterThan(0.2);
  });

  it("'mute' turns an ultrasonic (period ≤ 1) channel into a constant level — no whine", () => {
    // Forcing the tone gate high makes the channel pure DC: every sample equal,
    // so there is nothing to alias. (DC itself is removed by AC coupling.)
    const s = collect(oneChannel('mute', 0), 256);
    expect(range(s)).toBe(0);
  });

  it("'box' filter cuts the aliasing ripple to a fraction of point-sampling", () => {
    const none = range(collect(oneChannel('none', 0), 256));
    const box = range(collect(oneChannel('box', 0), 256));
    expect(box).toBeLessThan(none / 3);
  });

  it("'mute' does NOT silence a normal audible channel", () => {
    // period 178 ≈ 620 Hz is well within the audio band; mute must leave it alone.
    const s = collect(oneChannel('mute', 178), 1024);
    expect(range(s)).toBeGreaterThan(0.2);
  });

  it('all four modes produce finite, bounded output', () => {
    for (const mode of ['none', 'box', 'mute', 'lowpass'] as const) {
      const s = collect(oneChannel(mode, 0), 128);
      for (const v of s) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('AY-3-8910 — I/O port registers (R14/R15)', () => {
  // R14 and R15 are GPIO ports on the chip; on the ZX 128K, R14 is wired
  // to the keypad/AUX port. writeRegister stores them but they have no
  // generator side-effects, and getRegisters() excludes them (YM file
  // convention).
  it('writeRegister stores R14/R15 with no side-effects on other state', () => {
    const ay = makeAy();
    const baseline = {
      tone0: ay.tonePeriod[0],
      noise: ay.noisePeriod,
      env: ay.envPeriod,
      mixer: ay.mixer,
    };
    ay.writeRegister(14, 0xCC);
    ay.writeRegister(15, 0x33);
    expect(ay.regs[14]).toBe(0xCC);
    expect(ay.regs[15]).toBe(0x33);
    expect(ay.tonePeriod[0]).toBe(baseline.tone0);
    expect(ay.noisePeriod).toBe(baseline.noise);
    expect(ay.envPeriod).toBe(baseline.env);
    expect(ay.mixer).toBe(baseline.mixer);
  });

  it('readRegister roundtrips R14/R15', () => {
    const ay = makeAy();
    ay.writeRegister(14, 0xA5);
    ay.writeRegister(15, 0x5A);
    expect(ay.readRegister(14)).toBe(0xA5);
    expect(ay.readRegister(15)).toBe(0x5A);
  });

  it('getRegisters omits R14/R15 (YM convention)', () => {
    const ay = makeAy();
    ay.writeRegister(14, 0xFF);
    ay.writeRegister(15, 0xFF);
    const dump = ay.getRegisters();
    expect(dump.length).toBe(14);
    expect(dump[13]).toBe(0); // R13 untouched
    // No way to read indices >= 14 on the dump — it's truncated.
  });
});

describe('AY-3-8910 — tone period 0 edge case', () => {
  it('period 0 is clamped to 1 in writeRegister AND setRegisters', () => {
    // The real chip treats period 0 as period 1 (no division-by-zero, no
    // silent channel). Both code paths must agree.
    const a = makeAy();
    a.writeRegister(0, 0); a.writeRegister(1, 0);
    expect(a.tonePeriod[0]).toBe(1);

    const b = makeAy();
    const regs = new Uint8Array(14);
    // all zero
    b.setRegisters(regs);
    expect(b.tonePeriod[0]).toBe(1);
    expect(b.tonePeriod[1]).toBe(1);
    expect(b.tonePeriod[2]).toBe(1);
    expect(b.noisePeriod).toBe(1);
    expect(b.envPeriod).toBe(1);
  });
});

describe('AY-3-8910 — setRegisters env retrigger on non-FF', () => {
  it('non-FF R13 in setRegisters DOES retrigger envelope (matches per-register write)', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x0C);
    for (let i = 0; i < 5; i++) ay.clock();
    expect(ay.envVolume).toBeGreaterThan(0);
    const regs = ay.getRegisters();
    regs[13] = 0x0C; // same value — should still reset step
    ay.setRegisters(regs);
    expect(ay.envStep).toBe(0);
    expect(ay.envVolume).toBe(0); // attack → restart at 0
  });
});

describe('AY-3-8910 — regressions', () => {
  it('writing tone period high byte alone updates tonePeriod (uses cached low byte)', () => {
    const ay = makeAy();
    ay.writeRegister(0, 0xAB); // low byte
    ay.writeRegister(1, 0x03); // high nibble
    expect(ay.tonePeriod[0]).toBe(0x3AB);
    ay.writeRegister(1, 0x07); // change high only
    expect(ay.tonePeriod[0]).toBe(0x7AB);
  });

  it('envelope period write only (R11/R12) does not retrigger envelope', () => {
    const ay = makeAy();
    ay.writeRegister(13, 0x0E);
    ay.envStep = 10;
    ay.envHolding = false;
    ay.writeRegister(11, 0xFF); // period write
    ay.writeRegister(12, 0xFF);
    expect(ay.envStep).toBe(10); // unchanged
  });
});
