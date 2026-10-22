/**
 * ZN428E 8-bit DAC tests. The chip is an unsigned latched converter: output is
 * proportional to the 8-bit code (0x00 = 0 V, 0xFF = full scale) and only the
 * low 8 data lines are connected. Expected values are worked out from that, not
 * read back from the implementation.
 */

import { describe, it, expect } from 'vitest';
import { ZN428E, ZN428E_FULL_SCALE } from '@/cores/zn428e.ts';

describe('ZN428E', () => {
  it('powers up at code 0 / zero volts', () => {
    const dac = new ZN428E();
    expect(dac.code).toBe(0);
    expect(dac.level).toBe(0);
  });

  it('maps code 0x00 to 0 and full scale 0xFF to exactly 1', () => {
    const dac = new ZN428E();
    dac.write(0xFF);
    expect(ZN428E_FULL_SCALE).toBe(255);
    expect(dac.level).toBe(1);
    dac.write(0x00);
    expect(dac.level).toBe(0);
  });

  it('is unsigned: mid-scale codes sit above half, not at zero', () => {
    const dac = new ZN428E();
    dac.write(0x80);
    expect(dac.level).toBeCloseTo(128 / 255, 12); // 0.50196…, not 0
    dac.write(0x7F);
    expect(dac.level).toBeCloseTo(127 / 255, 12); // 0.49804…
    dac.write(0x33);
    expect(dac.level).toBeCloseTo(0.2, 12);       // 51/255
  });

  it('is strictly monotonic with a uniform 1/255 step across all 256 codes', () => {
    const dac = new ZN428E();
    let prev = -1;
    for (let c = 0; c < 256; c++) {
      dac.write(c);
      expect(dac.code).toBe(c);
      if (c > 0) expect(dac.level - prev).toBeCloseTo(1 / 255, 12);
      prev = dac.level;
    }
  });

  it('connects only the low 8 data lines: wider and negative values wrap', () => {
    const dac = new ZN428E();
    dac.write(0x100);
    expect(dac.code).toBe(0x00);   // bit 8 is not a data line
    dac.write(0x1AB);
    expect(dac.code).toBe(0xAB);
    dac.write(-1);
    expect(dac.code).toBe(0xFF);   // two's-complement low byte
    expect(dac.level).toBe(1);
  });

  it('holds the last code until a new one is written (no clock, no decay)', () => {
    const dac = new ZN428E();
    dac.write(0xC0);
    const a = dac.level;
    for (let i = 0; i < 1000; i++) dac.level; // reading must not disturb it
    expect(dac.code).toBe(0xC0);
    expect(dac.level).toBe(a);
  });

  it('reset returns to the power-on state', () => {
    const dac = new ZN428E();
    dac.write(0xFF);
    dac.reset();
    expect(dac.code).toBe(0);
    expect(dac.level).toBe(0);
  });

  it('instances are independent (two interfaces in one machine)', () => {
    const a = new ZN428E();
    const b = new ZN428E();
    a.write(0xFF);
    expect(b.code).toBe(0);
  });
});
