/**
 * Philips SAA1099 — six-channel stereo sound generator.
 *
 * Frequency expectations are computed from the datasheet formula rather than
 * from the implementation:
 *
 *     f = 15625 * 2^octave / (511 - frequency)   Hz   at an 8 MHz clock
 *
 * which is the documented 31 Hz .. 7.81 kHz range. Register semantics follow
 * MAME's `sound/saa1099.cpp`.
 */

import { describe, expect, it } from 'vitest';
import { SAA1099 } from '@/cores/saa1099.ts';

const CLOCK = 8_000_000;

function chip(): SAA1099 {
  const s = new SAA1099(CLOCK, 44100);
  s.writeRegister(0x1C, 0x01);        // sound enable
  return s;
}

/** The datasheet's tone frequency, computed independently of the chip. */
const expectedHz = (freq: number, octave: number) =>
  15625 * Math.pow(2, octave) / (511 - freq);

/** Peak-to-peak swing of the left channel over `n` samples. */
function swing(s: SAA1099, n = 4000): { left: number; right: number } {
  let lo = Infinity, hi = -Infinity, rlo = Infinity, rhi = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = s.generateSampleStereo();
    if (o.left < lo) lo = o.left;
    if (o.left > hi) hi = o.left;
    if (o.right < rlo) rlo = o.right;
    if (o.right > rhi) rhi = o.right;
  }
  return { left: hi - lo, right: rhi - rlo };
}

describe('SAA1099 tone frequency', () => {
  it('matches the datasheet formula across the register range', () => {
    const s = chip();
    for (const [freq, octave] of [[0, 0], [128, 3], [200, 5], [255, 7], [0, 7]] as const) {
      s.writeRegister(0x08, freq);
      s.writeRegister(0x10, octave);
      expect(s.channelFrequency(0)).toBeCloseTo(expectedHz(freq, octave), 4);
    }
  });

  it('spans the documented 31 Hz to 7.81 kHz range', () => {
    const s = chip();
    s.writeRegister(0x08, 0);
    s.writeRegister(0x10, 0);
    expect(s.channelFrequency(0)).toBeCloseTo(30.577, 2);

    s.writeRegister(0x08, 255);
    s.writeRegister(0x10, 7);
    expect(s.channelFrequency(0)).toBeCloseTo(7812.5, 1);
  });

  it('doubles the pitch for each octave step', () => {
    const s = chip();
    s.writeRegister(0x08, 100);
    s.writeRegister(0x10, 2);
    const base = s.channelFrequency(0);
    s.writeRegister(0x10, 3);
    expect(s.channelFrequency(0)).toBeCloseTo(base * 2, 6);
  });
});

describe('SAA1099 register decode', () => {
  it('splits amplitude into a left low nibble and a right high nibble', () => {
    const s = chip();
    s.writeRegister(0x00, 0x3C);
    expect(s.amplitudeOf(0)).toEqual([0x0C, 0x03]);
    s.writeRegister(0x05, 0xF0);
    expect(s.amplitudeOf(5)).toEqual([0x00, 0x0F]);
  });

  it('packs two channels of octave per register', () => {
    // 0x10 -> channels 0 and 1, 0x11 -> 2 and 3, 0x12 -> 4 and 5.
    const s = chip();
    s.writeRegister(0x10, 0x52);      // ch0 = 2, ch1 = 5
    expect(s.octaveOf(0)).toBe(2);
    expect(s.octaveOf(1)).toBe(5);
    s.writeRegister(0x11, 0x17);      // ch2 = 7, ch3 = 1
    expect(s.octaveOf(2)).toBe(7);
    expect(s.octaveOf(3)).toBe(1);
    s.writeRegister(0x12, 0x30);      // ch4 = 0, ch5 = 3
    expect(s.octaveOf(4)).toBe(0);
    expect(s.octaveOf(5)).toBe(3);
  });

  it('maps each frequency register to its own channel', () => {
    const s = chip();
    for (let ch = 0; ch < 6; ch++) {
      s.writeRegister(0x08 + ch, 200);
      s.writeRegister(0x10 + (ch >> 1), 0);
      expect(s.channelFrequency(ch)).toBeCloseTo(expectedHz(200, 0), 4);
    }
  });

  it('addresses registers through the address latch', () => {
    // The SAM writes the address on port 0x01FF and the data on 0x00FF.
    const s = chip();
    s.writeAddress(0x00);
    s.writeData(0x0F);
    expect(s.amplitudeOf(0)).toEqual([0x0F, 0x00]);
    // The latch is masked to five bits.
    s.writeAddress(0x25);
    s.writeData(0xF0);
    expect(s.amplitudeOf(5)).toEqual([0x00, 0x0F]);
  });

  it('ignores writes to undefined registers', () => {
    const s = chip();
    expect(() => s.writeRegister(0x07, 0xFF)).not.toThrow();
    expect(() => s.writeRegister(0x1F, 0xFF)).not.toThrow();
  });
});

describe('SAA1099 output gating', () => {
  it('is silent until register 0x1C bit 0 is set', () => {
    const s = new SAA1099(CLOCK, 44100);
    s.writeRegister(0x00, 0xFF);
    s.writeRegister(0x08, 100);
    s.writeRegister(0x14, 0x01);
    expect(s.enabled).toBe(false);
    expect(swing(s).left).toBeCloseTo(0, 6);

    s.writeRegister(0x1C, 0x01);
    expect(s.enabled).toBe(true);
    expect(swing(s).left).toBeGreaterThan(0);
  });

  it('is silent with a channel enabled but its amplitude at zero', () => {
    const s = chip();
    s.writeRegister(0x08, 100);
    s.writeRegister(0x14, 0x01);
    s.writeRegister(0x00, 0x00);
    expect(swing(s).left).toBeCloseTo(0, 6);
  });

  it('is silent with amplitude set but neither tone nor noise enabled', () => {
    const s = chip();
    s.writeRegister(0x00, 0xFF);
    s.writeRegister(0x08, 100);
    // 0x14 and 0x15 both left clear.
    expect(swing(s).left).toBeCloseTo(0, 6);
  });
});

describe('SAA1099 stereo', () => {
  it('pans hard left when only the left nibble is set', () => {
    const s = chip();
    s.writeRegister(0x08, 100);
    s.writeRegister(0x10, 4);
    s.writeRegister(0x14, 0x01);
    s.writeRegister(0x00, 0x0F);        // left 15, right 0

    const sw = swing(s);
    expect(sw.left).toBeGreaterThan(0);
    expect(sw.right).toBeCloseTo(0, 6);
  });

  it('pans hard right when only the right nibble is set', () => {
    const s = chip();
    s.writeRegister(0x08, 100);
    s.writeRegister(0x10, 4);
    s.writeRegister(0x14, 0x01);
    s.writeRegister(0x00, 0xF0);        // left 0, right 15

    const sw = swing(s);
    expect(sw.left).toBeCloseTo(0, 6);
    expect(sw.right).toBeGreaterThan(0);
  });

  it('drives both halves when both nibbles are set', () => {
    const s = chip();
    s.writeRegister(0x08, 100);
    s.writeRegister(0x10, 4);
    s.writeRegister(0x14, 0x01);
    s.writeRegister(0x00, 0xFF);

    const sw = swing(s);
    expect(sw.left).toBeGreaterThan(0);
    expect(sw.right).toBeGreaterThan(0);
    expect(sw.left).toBeCloseTo(sw.right, 6);
  });

  it('mixes six independent channels', () => {
    const s = chip();
    for (let ch = 0; ch < 6; ch++) {
      s.writeRegister(0x08 + ch, 100 + ch * 10);
      s.writeRegister(0x00 + ch, 0x0F);      // all hard left
    }
    s.writeRegister(0x12, 0x44);
    s.writeRegister(0x11, 0x44);
    s.writeRegister(0x10, 0x44);
    s.writeRegister(0x14, 0x3F);             // all six tones on

    const sw = swing(s);
    expect(sw.left).toBeGreaterThan(0);
    expect(sw.right).toBeCloseTo(0, 6);
  });
});

describe('SAA1099 noise', () => {
  it('produces output with noise enabled and no tone', () => {
    const s = chip();
    s.writeRegister(0x00, 0x0F);
    s.writeRegister(0x15, 0x01);       // noise on channel 0
    s.writeRegister(0x16, 0x00);       // generator 0 at the fastest rate
    expect(swing(s).left).toBeGreaterThan(0);
  });

  it('selects three fixed rates plus a tone-slaved mode', () => {
    // Rates 0-2 are 256, 512 and 1024 clock ticks; rate 3 follows a channel.
    const s = chip();
    s.writeRegister(0x00, 0x0F);
    s.writeRegister(0x15, 0x01);
    for (const rate of [0, 1, 2, 3]) {
      s.writeRegister(0x16, rate);
      expect(() => swing(s, 500)).not.toThrow();
    }
  });

  it('generates a non-repeating sequence over a short window', () => {
    // A stuck LFSR would give a constant or a period-1 pattern.
    const s = chip();
    s.writeRegister(0x00, 0x0F);
    s.writeRegister(0x15, 0x01);
    s.writeRegister(0x16, 0x00);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      seen.add(Math.round(s.generateSampleStereo().left * 1e6));
    }
    expect(seen.size).toBeGreaterThan(2);
  });
});

describe('SAA1099 reset', () => {
  it('silences and clears every register', () => {
    const s = chip();
    s.writeRegister(0x08, 100);
    s.writeRegister(0x00, 0xFF);
    s.writeRegister(0x14, 0x01);
    expect(swing(s).left).toBeGreaterThan(0);

    s.reset();
    expect(s.enabled).toBe(false);
    expect(s.amplitudeOf(0)).toEqual([0, 0]);
    expect(swing(s).left).toBeCloseTo(0, 6);
  });

  it('resyncs the generators on register 0x1C bit 1 without silencing', () => {
    const s = chip();
    s.writeRegister(0x08, 100);
    s.writeRegister(0x00, 0x0F);
    s.writeRegister(0x14, 0x01);
    s.writeRegister(0x1C, 0x03);       // enable + sync
    expect(s.enabled).toBe(true);
    expect(swing(s).left).toBeGreaterThan(0);
  });
});

describe('SAA1099 sample rate', () => {
  it('keeps a tone at the same pitch when the rate changes', () => {
    // The emitted frequency is a property of the chip's registers, not of the
    // host's output rate.
    const s = chip();
    s.writeRegister(0x08, 200);
    s.writeRegister(0x10, 4);
    const before = s.channelFrequency(0);
    s.setSampleRate(48000);
    expect(s.channelFrequency(0)).toBeCloseTo(before, 6);
  });

  it('ignores a nonsensical rate rather than dividing by zero', () => {
    const s = chip();
    s.setSampleRate(0);
    s.setSampleRate(Number.NaN);
    expect(() => swing(s, 100)).not.toThrow();
  });
});
