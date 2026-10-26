/**
 * Atari screen OCR tests.
 *
 * Expectations: ANTIC internal codes map to ATASCII as internal $00-$3F ->
 * $20-$5F and $60-$7F -> $60-$7F (lower case); text sits wherever the display
 * list puts it (blank runs, LMS, the scan counter advancing a whole mode line
 * at a time); modes 6/7 take a 6-bit code with CHBASE bit 1 choosing the
 * upper half of the set; the TEXT grid covers rows on the GRAPHICS 0 8-line
 * bands from buffer row 24.
 */

import { describe, it, expect } from 'vitest';
import { atariInternalChar, atariOcrGrid, atariOcrText, type AtariOcrInput } from '@/ocr/atari.ts';

/** ATASCII text to ANTIC internal codes. */
function internal(s: string): number[] {
  return [...s].map((c) => {
    const a = c.charCodeAt(0);
    if (a >= 0x20 && a < 0x60) return a - 0x20;
    return a; // lower case $60-$7F maps to itself
  });
}

function input(mem: Uint8Array, over: Partial<AtariOcrInput> = {}): AtariOcrInput {
  return {
    dlist: 0x2000, dmactl: 0x22, chbase: 0xe0, chactl: 0,
    colpf: [0x28, 0xca, 0x94, 0x46], colbk: 0, palette: new Uint32Array(256),
    read: (a) => mem[a & 0xffff],
    ...over,
  };
}

/** A ROM font where every glyph is distinct and non-blank (except space). */
function withRomFont(mem: Uint8Array): void {
  for (let code = 1; code < 128; code++) {
    for (let r = 0; r < 8; r++) mem[0xe000 + code * 8 + r] = (code * 7 + r * 13) & 0xff | 1;
  }
}

describe('atari OCR character set', () => {
  it('maps internal codes to text', () => {
    expect(atariInternalChar(0x00)).toBe(' ');
    expect(atariInternalChar(0x21)).toBe('A');
    expect(atariInternalChar(0x10)).toBe('0');
    expect(atariInternalChar(0x61)).toBe('a');
    expect(atariInternalChar(0xa1)).toBe('A'); // inverse video reads the same
  });
});

describe('atari OCR display-list walk', () => {
  it('reads a GRAPHICS 0 screen row by row', () => {
    const mem = new Uint8Array(0x10000);
    withRomFont(mem);
    mem.set([0x70, 0x70, 0x70, 0x42, 0x00, 0x30, 0x02, 0x41, 0x00, 0x20], 0x2000);
    mem.set(internal('READY'), 0x3000 + 2);
    mem.set(internal('Hello'), 0x3000 + 40);
    expect(atariOcrText(input(mem))).toBe('  READY\nHello');
  });

  it('follows LMS lines, skips map modes, and reads 20-column modes', () => {
    const mem = new Uint8Array(0x10000);
    withRomFont(mem);
    // Mode 7 title (LMS $3000), a mode-F line, then mode 2 at LMS $4000.
    mem.set([0x47, 0x00, 0x30, 0x0f, 0x42, 0x00, 0x40, 0x41, 0x00, 0x20], 0x2000);
    mem.set(internal('TITLE').map(c => c | 0x40), 0x3000); // colour bits 01
    mem.set(internal('MENU'), 0x4000);
    expect(atariOcrText(input(mem))).toBe('TITLE\nMENU');
  });

  it('reads the lower half of the set in modes 6/7 when CHBASE bit 1 is set', () => {
    const mem = new Uint8Array(0x10000);
    withRomFont(mem);
    mem.set([0x46, 0x00, 0x30, 0x41, 0x00, 0x20], 0x2000);
    mem.set([0x21, 0x22], 0x3000); // with the upper half: internal $61 $62
    // The empty cells are code 0, which in the upper half is the heart, as
    // anyone who has typed POKE 756,226 has seen.
    expect(atariOcrText(input(mem, { chbase: 0xe2 }))).toBe('ab' + '♥'.repeat(18));
  });

  it('reads a mode 6/7 character drawn in the background colour as a space', () => {
    // COLPF0 = COLBK hides the code-0 hearts of the lower-case half, a common
    // GRAPHICS 1/2 idiom; the screen shows nothing there.
    const mem = new Uint8Array(0x10000);
    withRomFont(mem);
    mem.set([0x46, 0x00, 0x30, 0x41, 0x00, 0x20], 0x2000);
    mem.set([0x00, 0x21 | 0x40], 0x3000); // code 0 in PF0, then 'a' in PF1
    const text = atariOcrText(input(mem, { chbase: 0xe2, colpf: [0x72, 0x0c, 0xb8, 0x48], colbk: 0x72 }));
    expect(text).toBe(' a');
  });

  it('reads nothing with display-list DMA off', () => {
    const mem = new Uint8Array(0x10000);
    mem.set([0x42, 0x00, 0x30, 0x41, 0x00, 0x20], 0x2000);
    mem.set(internal('HIDDEN'), 0x3000);
    expect(atariOcrText(input(mem, { dmactl: 0 }))).toBe('');
  });
});

describe('atari OCR with a program font', () => {
  /** A RAM font at $4000 that copies the ROM font, then blanks code 0x20. */
  function customFont(mem: Uint8Array): void {
    mem.copyWithin(0x4000, 0xe000, 0xe400);
    mem.fill(0, 0x4000 + 0x20 * 8, 0x4000 + 0x21 * 8);
  }

  it('reads a blank glyph as a space whatever its code', () => {
    const mem = new Uint8Array(0x10000);
    withRomFont(mem);
    customFont(mem);
    mem.set([0x42, 0x00, 0x30, 0x41, 0x00, 0x20], 0x2000);
    mem.set([...internal('A'), 0x20, ...internal('B')], 0x3000); // $20 is '@' in the ROM
    expect(atariOcrText(input(mem, { chbase: 0x40 }))).toBe('A B');
  });

  it('reads a ROM glyph moved to another code as its ROM character', () => {
    const mem = new Uint8Array(0x10000);
    withRomFont(mem);
    customFont(mem);
    mem.copyWithin(0x4000 + 0x05 * 8, 0xe000 + 0x21 * 8, 0xe000 + 0x22 * 8); // 'A' at code 5
    mem.set([0x42, 0x00, 0x30, 0x41, 0x00, 0x20], 0x2000);
    mem.set([0x05], 0x3000);
    expect(atariOcrText(input(mem, { chbase: 0x40 }))).toBe('A');
  });

  it('reads unknown glyphs in multicolour modes as spaces (graphics tiles)', () => {
    const mem = new Uint8Array(0x10000);
    withRomFont(mem);
    customFont(mem);
    mem.fill(0x5a, 0x4000 + 0x30 * 8, 0x4000 + 0x31 * 8); // not a ROM glyph
    mem.set([0x44, 0x00, 0x30, 0x42, 0x00, 0x31, 0x41, 0x00, 0x20], 0x2000);
    mem[0x3000] = 0x30;
    mem[0x3100] = 0x30;
    // Mode 4: a tile, so a space. Mode 2: keeps the code's letter ('P').
    expect(atariOcrText(input(mem, { chbase: 0x40 }))).toBe('P');
  });
});

describe('atari OCR overlay grid', () => {
  it('places GRAPHICS 0 rows on the 40x24 grid and masks their cells', () => {
    const mem = new Uint8Array(0x10000);
    withRomFont(mem);
    mem.set([0x70, 0x70, 0x70, 0x42, 0x00, 0x30, 0x02, 0x41, 0x00, 0x20], 0x2000);
    mem.set(internal('HI'), 0x3000 + 40 + 3);
    const g = atariOcrGrid(input(mem));
    expect(g.grid).toBe('40x24');
    expect(g.text.split('\n')[1].slice(3, 5)).toBe('HI');
    expect(g.mask[1 * 40 + 3]).toBe(true);
    expect(g.mask[1 * 40 + 5]).toBe(false);
  });

  it('gives a 16-pixel mode 6 character two cells', () => {
    const mem = new Uint8Array(0x10000);
    withRomFont(mem);
    mem.set([0x70, 0x70, 0x70, 0x46, 0x00, 0x30, 0x41, 0x00, 0x20], 0x2000);
    mem.set(internal('A'), 0x3000 + 1);
    const g = atariOcrGrid(input(mem));
    expect(g.text.split('\n')[0].slice(2, 4)).toBe('A ');
    expect(g.mask[2]).toBe(true);
    expect(g.mask[3]).toBe(true);
  });

  it('leaves off-grid rows out of the overlay', () => {
    const mem = new Uint8Array(0x10000);
    withRomFont(mem);
    // $20 is three blank lines, so the text row starts mid-band.
    mem.set([0x70, 0x70, 0x70, 0x20, 0x42, 0x00, 0x30, 0x41, 0x00, 0x20], 0x2000);
    mem.set(internal('OFF'), 0x3000);
    expect(atariOcrGrid(input(mem)).mask.some(Boolean)).toBe(false);
    expect(atariOcrText(input(mem))).toBe('OFF');
  });
});
