/**
 * The Plus/4 TEXT overlay's bitmap and multicolour support.
 *
 * The glyphs come from the character set the TED fetches through, so these
 * build a 4K set with a real 'A' at code 1 and drive the reader with it.
 */

import { describe, it, expect } from 'vitest';
import { plus4OcrGrid, type Plus4OcrInput } from '@/ocr/plus4.ts';
import { PLUS4_PALETTE } from '@/machines/plus4/palette.ts';

/** A capital A: the ROM's code 1. */
const A = [0x18, 0x3C, 0x66, 0x66, 0x7E, 0x66, 0x66, 0x00];

const CHAR_BASE = 0xD000;
const SCREEN = 0x0400;
const COLOUR = 0x0200;
const BITMAP = 0x0000;

function screen(mem: Uint8Array, overrides: Partial<Plus4OcrInput>): Plus4OcrInput {
  const chargen = new Uint8Array(0x1000);
  chargen.set(A, 8);                    // code 1
  const read = (addr: number): number => {
    const a = addr & 0xFFFF;
    if (a >= CHAR_BASE && a < CHAR_BASE + 0x1000) return chargen[a - CHAR_BASE];
    return mem[a];
  };
  return {
    charAddress: CHAR_BASE, screenAddress: SCREEN, colourAddress: COLOUR, bitmapAddress: BITMAP,
    mode: 0, reverse: false, background: 0, palette: PLUS4_PALETTE, read,
    ...overrides,
  };
}

function invert(bytes: readonly number[]): number[] {
  return bytes.map(b => ~b & 0xFF);
}

describe('Plus/4 OCR in the hires bitmap', () => {
  it('matches a cell against the ROM font, and its inverse in reverse video', () => {
    const mem = new Uint8Array(0x10000);
    for (let line = 0; line < 8; line++) {
      mem[BITMAP + line * 320] = A[line];             // cell 0: an A
      mem[BITMAP + line * 320 + 1] = invert(A)[line]; // cell 1: the A inverted
    }
    mem[COLOUR + 0] = 0x01;
    mem[COLOUR + 1] = 0x02;
    const grid = plus4OcrGrid(screen(mem, { mode: 2 }));
    expect(grid.text.slice(0, 2)).toBe('AA');
    expect(grid.mask[0]).toBe(true);
    expect(grid.mask[1]).toBe(true);
    // The direct glyph takes the cell's colour; the inverted one swaps it.
    expect(grid.paper?.[0]).toBe(0);
    expect(grid.paper?.[1]).toBe(2);
  });

  it('leaves a cell that is not a ROM glyph alone', () => {
    const mem = new Uint8Array(0x10000);
    for (let line = 0; line < 8; line++) {
      mem[BITMAP + line * 320] = 0x81;   // a shape no glyph has
      mem[BITMAP + line * 320 + 1] = 0x00;
    }
    const grid = plus4OcrGrid(screen(mem, { mode: 2 }));
    expect(grid.text[0]).toBe(' ');
    expect(grid.mask[0]).toBe(false);
  });

  it('does not read the multicolour bitmap as a glyph cell', () => {
    // The multicolour bitmap's cells are half-width, so mode 3 is left alone.
    const mem = new Uint8Array(0x10000);
    for (let line = 0; line < 8; line++) mem[BITMAP + line * 320] = A[line];
    const grid = plus4OcrGrid(screen(mem, { mode: 3 }));
    expect(grid.text[0]).toBe(' ');
  });
});

describe('Plus/4 OCR of a multicolour text cell', () => {
  it('reads the glyph, and treats its colour as the ink', () => {
    const mem = new Uint8Array(0x10000);
    mem[SCREEN] = 0x01;                 // the A's code
    mem[COLOUR] = 0x09;                 // multicolour cell, colour 1
    const grid = plus4OcrGrid(screen(mem, { mode: 1 }));
    expect(grid.text[0]).toBe('A');
    expect(grid.mask[0]).toBe(true);
    expect(grid.paper?.[0]).toBe(0);
  });

  it('leaves a graphics code alone', () => {
    const mem = new Uint8Array(0x10000);
    mem[SCREEN] = 0x41;                 // code 65 is graphics in the power-on set
    mem[COLOUR] = 0x09;
    const grid = plus4OcrGrid(screen(mem, { mode: 1 }));
    expect(grid.text[0]).toBe(' ');
  });
});
