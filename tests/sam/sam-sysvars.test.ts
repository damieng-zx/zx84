/**
 * SAM BASIC system variables.
 *
 * The SAM's are not the Spectrum's, and the two ways of getting them wrong are
 * both silent:
 *
 *  - reading them out of the CPU's 64K view instead of RAM page 0, which works
 *    right up until a program pages something else in at 0x4000;
 *  - reading a 3-byte page/offset pointer as a flat 16-bit address, which
 *    yields a plausible number naming nothing (PROG reads 0x9CD5 for a program
 *    that is at page 0, offset 0x1CD5).
 */

import { describe, expect, it } from 'vitest';
import {
  readSamByte, readSamPointer, readSamWord,
  SAM_CHARS_ADDR, SAM_PROG_PTR, SAM_SVARS, SAM_SYSVARS, SAM_SYSVAR_WINDOW,
} from '@/machines/sam/sysvars.ts';

function page(): Uint8Array {
  return new Uint8Array(0x4000);
}

function poke(p: Uint8Array, addr: number, ...bytes: number[]): void {
  p.set(bytes, addr - SAM_SYSVAR_WINDOW);
}

describe('SAM system variables', () => {
  it('numbers SVAR n from 0x5A00', () => {
    // The manual quotes CHARS as SVAR 566.
    expect(SAM_SVARS + 566).toBe(SAM_CHARS_ADDR);
  });

  it('reads a byte and a 16-bit word out of the system page', () => {
    const p = page();
    poke(p, 0x5A40, 0x03);
    poke(p, SAM_CHARS_ADDR, 0x90, 0x50);
    expect(readSamByte(p, 0x5A40)).toBe(3);
    expect(readSamWord(p, SAM_CHARS_ADDR)).toBe(0x5090);
  });

  it('splits a 3-byte pointer into a page and an offset within it', () => {
    const p = page();
    // PROG = page 0, offset 0x1CD5 — stored as 0x8000 + offset.
    poke(p, SAM_PROG_PTR, 0x00, 0xD5, 0x9C);
    expect(readSamPointer(p, SAM_PROG_PTR)).toEqual({ page: 0, offset: 0x1CD5, raw: 0x9CD5 });
  });

  it('carries an offset past 0xBFFF into the following page', () => {
    const p = page();
    // The manual allows the offset to run into the next window.
    poke(p, SAM_PROG_PTR, 0x04, 0x00, 0xC1);
    expect(readSamPointer(p, SAM_PROG_PTR)).toEqual({ page: 5, offset: 0x0100, raw: 0xC100 });
  });

  it('lists only variables inside the system page window', () => {
    for (const pair of SAM_SYSVARS) {
      for (const def of pair) {
        expect(def.addr).toBeGreaterThanOrEqual(SAM_SYSVAR_WINDOW);
        expect(def.addr).toBeLessThan(SAM_SYSVAR_WINDOW + 0x4000);
        expect(def.tip.length).toBeGreaterThan(0);
      }
    }
  });

  it('names each variable once', () => {
    const names = SAM_SYSVARS.flat().map(d => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
