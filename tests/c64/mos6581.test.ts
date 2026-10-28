/**
 * MOS 6581 SID — the parts software reads back. Voice 3's oscillator ($D41B,
 * the top eight bits of its waveform) and envelope ($D41C) are what programs
 * use for random numbers and timing, so they are checked against the data
 * sheet's definitions: the accumulator adds the 16-bit frequency every
 * clock, the sawtooth is its top 12 bits, TEST holds it at zero, and an
 * attack of 0 climbs the envelope one step every 9 clocks (2.3 ms to full,
 * the measured figure behind the sheet's nominal 2 ms).
 */

import { describe, it, expect } from 'vitest';
import { Mos6581 } from '@/cores/mos6581.ts';

const V3 = 14;   // voice 3's register base

function sid(): Mos6581 {
  const s = new Mos6581(985_248);
  s.reset();
  s.audible = false;
  return s;
}

describe('6581 voice 3 readback', () => {
  it("reads the sawtooth as the accumulator's top byte", () => {
    const s = sid();
    s.write(V3 + 0, 0x00);
    s.write(V3 + 1, 0x10);                     // frequency $1000
    s.write(V3 + 4, 0x20);                     // sawtooth
    s.advanceTo(100);                          // accumulator $1000 * 100 = $64000
    expect(s.read(0x1B)).toBe(0x06);
  });

  it('holds the oscillator at zero while TEST is set', () => {
    const s = sid();
    s.write(V3 + 1, 0xFF);
    s.write(V3 + 4, 0x28);                     // sawtooth + TEST
    s.advanceTo(10_000);
    expect(s.read(0x1B)).toBe(0);
  });

  it('gives noise that changes as the oscillator runs', () => {
    const s = sid();
    s.write(V3 + 0, 0xFF);
    s.write(V3 + 1, 0xFF);
    s.write(V3 + 4, 0x80);
    const seen = new Set<number>();
    for (let t = 1; t <= 64; t++) { s.advanceTo(t * 50); seen.add(s.read(0x1B)); }
    expect(seen.size).toBeGreaterThan(16);
  });

  it('climbs a 0-attack envelope to full in 255 steps of 9 clocks', () => {
    const s = sid();
    s.write(V3 + 5, 0x00);
    s.write(V3 + 6, 0xF0);
    s.write(V3 + 4, 0x01);                     // gate
    s.advanceTo(9 * 128);
    expect(s.read(0x1C)).toBe(128);
    s.advanceTo(9 * 255);
    expect(s.read(0x1C)).toBe(0xFF);
  });

  it('releases to zero and stays there', () => {
    const s = sid();
    s.write(V3 + 5, 0x00);
    s.write(V3 + 6, 0xF0);
    s.write(V3 + 4, 0x01);
    s.advanceTo(3000);
    s.write(V3 + 4, 0x00);                     // gate off, release 0
    s.advanceTo(400_000);
    expect(s.read(0x1C)).toBe(0);
  });
});
