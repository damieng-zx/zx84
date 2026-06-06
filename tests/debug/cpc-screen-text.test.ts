/**
 * CPC screen OCR — character-set coverage.
 *
 * The OCR engine decodes each 8×8 cell to a 1-bpp glyph and matches it against
 * the firmware font, then maps the matched font code to a Unicode character.
 * The full CPC character set is non-trivial: the ASCII range is standard *except*
 * 0x5E (↑, with the caret displaced to 0xA0), and the high range carries £, ©,
 * Greek letters, box graphics and arrows. These tests pin a representative slice
 * of that mapping, with expected characters taken from the published character
 * set (en.wikipedia.org/wiki/Amstrad_CPC_character_set), not from the code.
 */

import { describe, it, expect } from 'vitest';
import { CpcScreenText, type CpcOcrInput } from '@/debug/cpc-screen-text.ts';

/** A distinctive non-blank 8×8 bitmap. Its exact shape is irrelevant — the test
 *  fonts contain at most one non-blank glyph, so any non-zero pattern matches
 *  uniquely. (Must be non-zero, else it would match the blank space slot.) */
const MARK = [0x18, 0x24, 0x42, 0x7E, 0x42, 0x42, 0x42, 0x00];

/** A 2048-byte (256-glyph) font, all blank except `glyph` planted at `code`. */
function fontWith(code: number, glyph: number[]): Uint8Array {
  const font = new Uint8Array(2048);
  for (let i = 0; i < 8; i++) font[code * 8 + i] = glyph[i];
  return font;
}

/** CPC video byte address (mirrors GateArray.renderScanline). */
function videoAddr(ma: number, ra: number): number {
  return (((ma & 0x3000) << 2) | ((ra & 7) << 11) | ((ma & 0x3FF) << 1)) & 0xFFFF;
}

/**
 * A mode-2 (1 byte/column) display backing store with `glyph` at cell (0,0). In
 * mode 2 each display byte's bits map straight to pixels, so the glyph byte and
 * the screen byte are identical. dispStart = 0 → cell (0,0) is CRTC char 0,
 * whose raster p lives at videoAddr(0, p).
 */
function readVideoFor(glyph: number[]): (addr: number) => number {
  const ram = new Uint8Array(0x10000);
  for (let p = 0; p < 8; p++) ram[videoAddr(0, p)] = glyph[p];
  return (addr: number) => ram[addr & 0xFFFF];
}

function input(glyph: number[], font: Uint8Array): CpcOcrInput {
  return { readVideo: readVideoFor(glyph), mode: 2, dispStart: 0, hDisplayed: 40, rows: 1, font };
}

/** OCR a single glyph planted at `code` in an otherwise blank font. */
function ocrCode(code: number): string {
  return new CpcScreenText().ocr(input(MARK, fontWith(code, MARK)));
}

describe('CpcScreenText — character-set mapping', () => {
  // [font code, expected Unicode] — independently sourced from the CPC charset.
  const cases: [number, string][] = [
    [0x41, 'A'],   // ASCII letter, unchanged
    [0x35, '5'],   // ASCII digit, unchanged
    [0x5E, '↑'],   // ASCII slot, but the CPC draws an up-arrow here…
    [0xA0, '^'],   // …and the caret moves to 0xA0
    [0xA3, '£'],   // pound sign — the originally-reported gap
    [0xA4, '©'],   // copyright
    [0xA5, '¶'],   // pilcrow
    [0xA6, '§'],   // section
    [0xAB, '±'],   // plus-minus
    [0xAC, '÷'],   // division
    [0xB0, 'α'],   // Greek alpha
    [0xB8, 'π'],   // Greek pi
    [0xBF, 'Ω'],   // Greek omega
    [0x85, '▌'],   // left-half block mosaic
    [0x95, '│'],   // box-drawing vertical
    [0xE2, '♣'],   // club
    [0xF4, '▲'],   // up triangle
  ];

  for (const [code, expected] of cases) {
    it(`code 0x${code.toString(16).toUpperCase().padStart(2, '0')} → ${expected}`, () => {
      expect(ocrCode(code)[0]).toBe(expected);
    });
  }
});

describe('CpcScreenText — matching rules', () => {
  it('a blank cell reads as a space', () => {
    const font = new Uint8Array(2048); // entirely blank
    const text = new CpcScreenText().ocr(input([0, 0, 0, 0, 0, 0, 0, 0], font));
    expect(text[0]).toBe(' ');
  });

  it('an ASCII letter wins a glyph collision with a high-range graphic', () => {
    // Plant the SAME bitmap under both 'A' (0x41) and a block-graphic code
    // (0xCF). ASCII is tried first, so the cell must read as 'A', never the
    // graphic — this is what keeps real text from being corrupted by mosaics.
    const font = new Uint8Array(2048);
    for (let i = 0; i < 8; i++) { font[0x41 * 8 + i] = MARK[i]; font[0xCF * 8 + i] = MARK[i]; }
    expect(new CpcScreenText().ocr(input(MARK, font))[0]).toBe('A');
  });

  it('marks a matched high-range cell so ocrStyled blanks it for the overlay', () => {
    const pens = new Uint8Array(17).fill(1);
    const palette = new Uint32Array(32).fill(0xFFFFFFFF);
    const result = new CpcScreenText().ocrStyled(input(MARK, fontWith(0xA3, MARK)), pens, palette);
    expect(result.text[0]).toBe('£');
    expect(result.mask[0]).toBe(true);
  });
});
