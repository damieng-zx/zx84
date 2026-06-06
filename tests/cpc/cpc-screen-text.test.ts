/**
 * CPC screen OCR engine.
 *
 * The CPC renders text through a fixed 8×8 font; OCR decodes the bitmap back to
 * characters, mode-aware. These tests build a synthetic font and paint glyphs
 * into a flat 64KB display RAM using the *documented* CPC screen address formula
 * and pixel packing (NOT by calling the engine's internals), then assert the
 * engine recovers the text. Addresses and pixel encodings are derived from the
 * CPC hardware spec so a bug in the engine's addressing/decoding is caught.
 */

import { describe, it, expect } from 'vitest';
import { CpcScreenText, cpcCols, cpcGrid, type CpcOcrInput } from '@/debug/cpc-screen-text.ts';

// Two distinct, non-blank, non-solid glyphs assigned to 'A' (0x41) and 'B'.
const GLYPH_A = [0x18, 0x24, 0x42, 0x42, 0x7E, 0x42, 0x42, 0x00];
const GLYPH_B = [0x7C, 0x42, 0x42, 0x7C, 0x42, 0x42, 0x7C, 0x00];

function makeFont(): Uint8Array {
  const font = new Uint8Array(2048);
  for (let p = 0; p < 8; p++) {
    font[0x41 * 8 + p] = GLYPH_A[p];
    font[0x42 * 8 + p] = GLYPH_B[p];
  }
  return font;
}

/** Documented CPC display byte address for CRTC char `c`, raster `r` in the text
 *  row whose memory-address base is `maRow` (= dispStart + trow·R1). The +half
 *  picks the odd (b1) byte of the CRTC character pair. */
function cpcAddr(maRow: number, c: number, r: number): number {
  const ma = (maRow + c) & 0x3FFF;
  return (((ma & 0x3000) << 2) | ((r & 7) << 11) | ((ma & 0x3FF) << 1)) & 0xFFFF;
}

/** Paint a glyph into one 8×8 text cell, encoding ink as pen 1, per mode.
 *  `invert` paints ink where the glyph bit is CLEAR (inverse video). */
function paintCell(
  vram: Uint8Array, mode: number, dispStart: number, hDisplayed: number,
  trow: number, col: number, glyph: number[], invert = false,
): void {
  const maRow = (dispStart + trow * hDisplayed) & 0x3FFF;
  const bpc = mode === 0 ? 4 : mode === 1 ? 2 : 1;
  const start = col * bpc;
  for (let r = 0; r < 8; r++) {
    const g = invert ? (~glyph[r] & 0xFF) : glyph[r];
    for (let k = 0; k < bpc; k++) {
      const byteIndex = start + k;
      const c = byteIndex >> 1;
      const half = byteIndex & 1;
      const addr = cpcAddr(maRow, c, r) + half;
      if (mode === 2) {
        vram[addr] = g;                                   // 1 bpp: bit = ink
      } else if (mode === 1) {
        // 2 bytes/col: b0 = left 4 px (bits 7..4), b1 = right 4 px.
        vram[addr] = k === 0 ? (g & 0xF0) : ((g << 4) & 0xF0);
        // (k iterates the two bytes; both land via this call's addr.)
      } else {
        // mode 0: 4 bytes/col, 2 px/byte at byte bits 7 (penA) and 6 (penB).
        const hi = (g >> (7 - 2 * k)) & 1;
        const lo = (g >> (6 - 2 * k)) & 1;
        vram[addr] = (hi ? 0x80 : 0) | (lo ? 0x40 : 0);
      }
    }
  }
}

const DISP_START = 0x3000; // R12:R13 for the &C000 screen base
const H_DISPLAYED = 40;

function input(vram: Uint8Array, mode: number, font: Uint8Array, rows = 25): CpcOcrInput {
  return {
    readVideo: (addr: number) => vram[addr & 0xFFFF],
    mode, dispStart: DISP_START, hDisplayed: H_DISPLAYED, rows, font,
  };
}

describe('cpcCols / cpcGrid', () => {
  it('derives the column count from mode and R1 (40 CRTC chars = 80 bytes)', () => {
    expect(cpcCols(0, 40)).toBe(20);
    expect(cpcCols(1, 40)).toBe(40);
    expect(cpcCols(2, 40)).toBe(80);
  });

  it('labels the grid by mode (mode 3 treated as mode 2)', () => {
    expect(cpcGrid(0)).toBe('20x25');
    expect(cpcGrid(1)).toBe('40x25');
    expect(cpcGrid(2)).toBe('80x25');
    expect(cpcGrid(3)).toBe('80x25');
  });
});

describe('CpcScreenText.ocr — mode awareness', () => {
  for (const mode of [0, 1, 2]) {
    it(`recovers "AB" rendered in mode ${mode}`, () => {
      const font = makeFont();
      const vram = new Uint8Array(0x10000);
      paintCell(vram, mode, DISP_START, H_DISPLAYED, 0, 0, GLYPH_A);
      paintCell(vram, mode, DISP_START, H_DISPLAYED, 0, 1, GLYPH_B);
      const eng = new CpcScreenText();
      const line0 = eng.ocr(input(vram, mode, font)).split('\n')[0];
      expect(line0.replace(/\s+$/, '')).toBe('AB');
    });
  }

  it('reads inverse-video text (ink where the glyph is clear)', () => {
    const font = makeFont();
    const vram = new Uint8Array(0x10000);
    paintCell(vram, 2, DISP_START, H_DISPLAYED, 0, 0, GLYPH_A, true);
    const eng = new CpcScreenText();
    const line0 = eng.ocr(input(vram, 2, font)).split('\n')[0];
    expect(line0.replace(/\s+$/, '')).toBe('A');
  });

  it('places text on the correct row using the CRTC row stride', () => {
    const font = makeFont();
    const vram = new Uint8Array(0x10000);
    paintCell(vram, 1, DISP_START, H_DISPLAYED, 2, 3, GLYPH_B); // row 2, col 3
    const eng = new CpcScreenText();
    const lines = eng.ocr(input(vram, 1, font)).split('\n');
    expect(lines[0].trim()).toBe('');
    expect(lines[1].trim()).toBe('');
    expect(lines[2][3]).toBe('B');
    expect(lines[2].replace(/\s+$/, '')).toBe('   B');
  });

  it('returns all spaces for a blank screen', () => {
    const font = makeFont();
    const vram = new Uint8Array(0x10000);
    const eng = new CpcScreenText();
    const text = eng.ocr(input(vram, 1, font, 3));
    expect(text).toBe([' '.repeat(40), ' '.repeat(40), ' '.repeat(40)].join('\n'));
  });
});

/** Paint a glyph into a mode-1 cell with explicit paper/ink pens (0–3). Mode 1
 *  packs 4 px/byte: pixel j of a byte takes bit0 from bit(7−j), bit1 from
 *  bit(3−j) — the inverse of cpc-screen-text's decodePens. */
function paintCellMode1Colored(
  vram: Uint8Array, dispStart: number, hDisplayed: number,
  trow: number, col: number, glyph: number[], paperPen: number, inkPen: number,
): void {
  const maRow = (dispStart + trow * hDisplayed) & 0x3FFF;
  const start = col * 2;
  for (let r = 0; r < 8; r++) {
    for (let k = 0; k < 2; k++) {
      const byteIndex = start + k;
      const addr = cpcAddr(maRow, byteIndex >> 1, r) + (byteIndex & 1);
      let b = 0;
      for (let j = 0; j < 4; j++) {
        const px = k * 4 + j;                              // pixel x within cell
        const v = ((glyph[r] >> (7 - px)) & 1) ? inkPen : paperPen;
        if (v & 1) b |= 0x80 >> j;                          // pen bit0 → bit(7−j)
        if (v & 2) b |= 0x08 >> j;                          // pen bit1 → bit(3−j)
      }
      vram[addr] = b;
    }
  }
}

describe('CpcScreenText — non-default paper colour', () => {
  it('recovers text drawn on a non-zero PAPER pen (PAPER 2, PEN 1)', () => {
    const font = makeFont();
    const vram = new Uint8Array(0x10000);
    // Background pen 2, ink pen 1 — i.e. PAPER 2 / PEN 1. The old engine treated
    // pen 0 as the sole background, so the pen-2 paper read as solid ink and the
    // glyph matched nothing. Paper must be inferred from the cell itself.
    paintCellMode1Colored(vram, DISP_START, H_DISPLAYED, 0, 0, GLYPH_A, 2, 1);
    paintCellMode1Colored(vram, DISP_START, H_DISPLAYED, 0, 1, GLYPH_B, 2, 1);
    const line0 = new CpcScreenText().ocr(input(vram, 1, font)).split('\n')[0];
    expect(line0.replace(/\s+$/, '')).toBe('AB');
  });

  it('reports the ink pen (not the paper pen) as the cell colour', () => {
    const font = makeFont();
    const vram = new Uint8Array(0x10000);
    paintCellMode1Colored(vram, DISP_START, H_DISPLAYED, 0, 0, GLYPH_A, 2, 1);

    const pens = new Uint8Array(17);
    pens[1] = 26; pens[2] = 6;                  // ink pen 1 → green, paper pen 2 → red
    const palette = new Uint32Array(32);
    palette[26] = 0xFF00FF00;                    // ABGR green
    palette[6] = 0xFF0000FF;                     // ABGR red

    const r = new CpcScreenText().ocrStyled(input(vram, 1, font), pens, palette);
    expect(r.text.split('\n')[0].replace(/\s+$/, '')).toBe('A');
    expect(r.html).toContain('color:#00ff00');   // ink green, not paper red
    expect(r.html).not.toContain('color:#ff0000');
    // The cell's paper pen (2) is reported so blankCells fills it with the right
    // colour instead of a hard-coded pen 0.
    expect(r.paper![0]).toBe(2);
  });

  it('still reads a blank PAPER-2 screen as all spaces', () => {
    const font = makeFont();
    const vram = new Uint8Array(0x10000);
    // Fill a row entirely with paper pen 2 (no ink): every cell must be a space.
    for (let col = 0; col < 40; col++) {
      paintCellMode1Colored(vram, DISP_START, H_DISPLAYED, 0, col, [0, 0, 0, 0, 0, 0, 0, 0], 2, 1);
    }
    const line0 = new CpcScreenText().ocr(input(vram, 1, font, 1)).split('\n')[0];
    expect(line0).toBe(' '.repeat(40));
  });
});

describe('CpcScreenText.ocrStyled', () => {
  it('marks matched non-space cells, labels the grid, and colours the HTML', () => {
    const font = makeFont();
    const vram = new Uint8Array(0x10000);
    paintCell(vram, 1, DISP_START, H_DISPLAYED, 0, 0, GLYPH_A);
    paintCell(vram, 1, DISP_START, H_DISPLAYED, 0, 1, GLYPH_B);

    const pens = new Uint8Array(17);
    pens[1] = 26; // pen 1 → hardware colour 26 (bright green) in CPC_PALETTE
    const palette = new Uint32Array(32);
    palette[26] = 0xFF00FF00; // ABGR: opaque green

    const eng = new CpcScreenText();
    const r = eng.ocrStyled(input(vram, 1, font), pens, palette);

    expect(r.grid).toBe('40x25');
    expect(r.cols).toBe(40);
    expect(r.cellWidth).toBe(8);
    expect(r.text.split('\n')[0].replace(/\s+$/, '')).toBe('AB');
    // Cells 0 and 1 matched; cell 2 is blank → not masked.
    expect(r.mask[0]).toBe(true);
    expect(r.mask[1]).toBe(true);
    expect(r.mask[2]).toBe(false);
    expect(r.html).toContain('>AB'); // same ink colour → one span
    expect(r.html).toContain('color:#00ff00');
  });
});
