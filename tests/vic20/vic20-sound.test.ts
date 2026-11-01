/**
 * The VIC's sound: the tone each voice makes for a register value, a voice
 * switched off, and the volume register on its own.
 *
 * The frequencies follow the Programmer's Reference Guide: bass, alto and
 * soprano run from clocks of the CPU clock over 256, 128 and 64 (4329, 8659
 * and 17320 Hz on a PAL machine), divided by the count the 7-bit value leaves
 * to 128.
 */

import { describe, it, expect } from 'vitest';
import { VicSound } from '@/machines/vic20/vic-sound.ts';
import { VIC20_PAL_CLOCK } from '@/machines/vic20/constants.ts';

/** Rising edges of voice `v` over one second of PAL clock, after a warm-up:
 *  a counter only loads the register's value when it first overflows, up to
 *  128 × 16 clocks after reset. */
function edgesPerSecond(regs: Uint8Array, v: number): number {
  const s = new VicSound(regs, VIC20_PAL_CLOCK);
  s.audible = false;
  const warm = 128 * 16;
  s.advanceTo(warm);
  let prev = s.voiceBit(v);
  let edges = 0;
  for (let t = 1; t <= VIC20_PAL_CLOCK; t++) {
    s.advanceTo(warm + t);
    const bit = s.voiceBit(v);
    if (bit && !prev) edges++;
    prev = bit;
  }
  return edges;
}

describe('VIC sound', () => {
  it.each([
    ['bass', 0, 100, 256],
    ['alto', 1, 64, 128],
    ['soprano', 2, 0, 64],
    ['soprano, highest', 2, 127, 64],
  ])('%s at X=%i', (_name, voice, x, divider) => {
    const regs = new Uint8Array(16);
    regs[10 + voice] = 0x80 | x;
    const expected = VIC20_PAL_CLOCK / divider / (128 - x);
    expect(Math.abs(edgesPerSecond(regs, voice) - expected)).toBeLessThanOrEqual(1);
  });

  it('falls silent when a voice is switched off', () => {
    const regs = new Uint8Array(16);
    regs[10] = 0x80 | 120;
    const s = new VicSound(regs, VIC20_PAL_CLOCK);
    s.audible = false;
    s.advanceTo(100_000);
    regs[10] = 120;                      // off
    // One period of the bass at X=120 is 256 × 8 clocks; give it two.
    s.advanceTo(100_000 + 2 * 256 * 8);
    let any = 0;
    for (let t = 1; t <= 50_000; t++) { s.advanceTo(100_000 + 4096 + t); any |= s.voiceBit(0); }
    expect(any).toBe(0);
  });

  it('is silent at volume 0 whatever the voices do', () => {
    const regs = new Uint8Array(16);
    regs[12] = 0x80 | 100;
    regs[14] = 0;
    const s = new VicSound(regs, VIC20_PAL_CLOCK);
    s.advanceTo(10_000);
    let peak = 0;
    for (let i = 0; i < 200; i++) peak = Math.max(peak, s.generateSampleStereo().left);
    expect(peak).toBe(0);
  });

  it('makes a level from the volume register alone (sampled sound)', () => {
    const regs = new Uint8Array(16);
    const s = new VicSound(regs, VIC20_PAL_CLOCK);
    regs[14] = 0x00;
    s.advanceTo(2_000);
    const quiet = drain(s);
    regs[14] = 0x0F;
    s.advanceTo(4_000);
    const loud = drain(s);
    expect(quiet).toBe(0);
    expect(loud).toBeGreaterThan(0);
  });
});

/** The last queued sample. */
function drain(s: VicSound): number {
  let v = 0;
  for (let i = 0; i < 1000; i++) v = s.generateSampleStereo().left;
  return v;
}
