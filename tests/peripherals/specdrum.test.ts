/**
 * SpecDrum interface tests. The board decodes only the low address byte (0xDF),
 * ignores A8-A15, is write-only, and feeds an unsigned 8-bit ZN428E.
 */

import { describe, it, expect } from 'vitest';
import { SpecDrum } from '@/machines/spectrum/peripherals/specdrum.ts';

describe('SpecDrum port decode', () => {
  const drum = new SpecDrum();

  it('answers to low byte 0xDF with any high byte', () => {
    for (const port of [0x00DF, 0xFFDF, 0x7FDF, 0xBFDF, 0x1FDF, 0xDFDF, 0x80DF]) {
      expect(drum.matchPort(port), `0x${port.toString(16)}`).toBe(true);
    }
  });

  it('ignores every other low byte, including near-misses', () => {
    const misses = [
      0x00DE, 0x00DD, 0x00DB, 0x00D7, 0x00CF, 0x009F, 0x00FF, 0x005F, // one bit off 0xDF
      0x001F, 0x00E7, 0x00FE, 0x00FD, 0x007F, 0x00BF, 0x0000,
    ];
    for (const port of misses) {
      expect(drum.matchPort(port), `0x${port.toString(16)}`).toBe(false);
    }
  });

  it('does not match 0xDF in the high byte alone', () => {
    expect(drum.matchPort(0xDF00)).toBe(false);
    expect(drum.matchPort(0xDFFE)).toBe(false);
  });
});

describe('SpecDrum output', () => {
  it('starts disabled with a silent DAC', () => {
    const drum = new SpecDrum();
    expect(drum.enabled).toBe(false);
    expect(drum.dac.code).toBe(0);
    expect(drum.level).toBe(0);
  });

  it('latches a written byte into the DAC (unsigned: 0x00 → 0, 0xFF → full scale)', () => {
    const drum = new SpecDrum();
    drum.writePort(0xFF);
    expect(drum.dac.code).toBe(0xFF);
    expect(drum.level).toBe(1);
    drum.writePort(0x00);
    expect(drum.dac.code).toBe(0);
    expect(drum.level).toBe(0);
    drum.writePort(0x80);
    expect(drum.level).toBeCloseTo(128 / 255, 12);
  });

  it('keeps only the low 8 bits of the written value', () => {
    const drum = new SpecDrum();
    drum.writePort(0x1C3);
    expect(drum.dac.code).toBe(0xC3);
  });

  it('reset clears the latch', () => {
    const drum = new SpecDrum();
    drum.writePort(0xA5);
    drum.reset();
    expect(drum.dac.code).toBe(0);
    expect(drum.level).toBe(0);
  });

  it('reset does not change whether the interface is fitted', () => {
    const drum = new SpecDrum();
    drum.enabled = true;
    drum.reset();
    expect(drum.enabled).toBe(true);
  });
});
