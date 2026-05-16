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
    let period = 0;
    for (let i = 1; i <= 200000; i++) {
      ay.clock();
      if (ay.noiseRng === seed) { period = i; break; }
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
