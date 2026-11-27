/**
 * V9938 display modes from the five mode bits.
 *
 * `mode()` is on the per-scanline render path and also runs on every VRAM port
 * transfer (the address mapper asks whether the machine is in G6/G7), so it
 * used to assemble a "M5M4M3M2M1" string to key a record — an allocation and a
 * hash per call. It now packs the bits into an index and reads a 32-entry
 * table.
 *
 * The expectations are the V9938 data book's mode table (M1-M5 combinations),
 * not the old implementation: bit values here are R0 M5/M4/M3 = bits 3/2/1 and
 * R1 M2/M1 = bits 3/4.
 */

import { describe, expect, it } from 'vitest';
import { V9938 } from '@/cores/v9938.ts';

/** The mode for a given set of M bits. R0 M5/M4/M3 are bits 3/2/1 and R1
 *  M2/M1 are bits 3/4, as the machine writes them. */
function modeFor(m1: boolean, m2: boolean, m3: boolean, m4: boolean, m5: boolean): string {
  const vdp = new V9938();
  vdp.regs[0] = (m5 ? 0x08 : 0) | (m4 ? 0x04 : 0) | (m3 ? 0x02 : 0);
  // The register-write path masks to the real width, so go through it rather
  // than poking the array (R0 only implements bits 1-3, R1 bits 3-4).
  vdp.regs[17] = 0; vdp.writeRegister(vdp.regs[0]);
  vdp.regs[17] = 1; vdp.writeRegister((m1 ? 0x10 : 0) | (m2 ? 0x08 : 0));
  return vdp.mode();
}

describe('V9938 display modes', () => {
  it('names every mode in the data book table', () => {
    expect(modeFor(false, false, false, false, false), 'no M bits').toBe('graphic1');
    expect(modeFor(true, false, false, false, false), 'M1').toBe('text1');
    expect(modeFor(false, true, false, false, false), 'M2').toBe('multicolor');
    expect(modeFor(false, false, true, false, false), 'M3').toBe('graphic2');
    expect(modeFor(false, false, false, true, false), 'M4').toBe('graphic3');
    expect(modeFor(true, false, false, true, false), 'M4+M1').toBe('text2');
    expect(modeFor(false, false, true, true, false), 'M4+M3').toBe('graphic4');
    expect(modeFor(false, false, false, false, true), 'M5').toBe('graphic5');
    expect(modeFor(false, false, true, false, true), 'M5+M3').toBe('graphic6');
    expect(modeFor(false, false, true, true, true), 'M5+M4+M3').toBe('graphic7');
  });

  it('reports an unknown mode for a combination the table does not define', () => {
    // M1 with M2 is not a documented mode; neither is M4 alone with M1 and M2.
    expect(modeFor(true, true, false, false, false)).toBe('unknown');
    expect(modeFor(true, false, false, false, true)).toBe('unknown');
    expect(modeFor(true, true, true, true, true)).toBe('unknown');
  });

  it('distinguishes every documented mode from every other', () => {
    // The bit packing has to be one-to-one: a collision would silently render
    // one mode as another.
    const seen = new Set<string>();
    for (const m1 of [false, true]) for (const m2 of [false, true]) for (const m3 of [false, true]) {
      for (const m4 of [false, true]) for (const m5 of [false, true]) {
        const mode = modeFor(m1, m2, m3, m4, m5);
        if (mode === 'unknown') continue;
        expect(seen.has(mode), `${mode} named twice`).toBe(false);
        seen.add(mode);
      }
    }
    expect(seen.size, 'the ten documented modes').toBe(10);
  });
});
