/**
 * Jupiter Ace screen OCR.
 *
 * The Ace stores character codes in its screen file, so transcription is a
 * read rather than a recognition: these tests pin the code mapping, inverse
 * video and the shape of the overlay result.
 */

import { describe, expect, it } from 'vitest';
import {
  ACE_OCR_COLS, ACE_OCR_ROWS, aceOcrResult, aceScreenCells, aceScreenText,
} from '@/ocr/jupiter-ace.ts';

/** A 1KB screen file with `lines` laid along the top, spaces elsewhere. */
function screenOf(lines: string[], inverseRows: number[] = []): Uint8Array {
  const vram = new Uint8Array(ACE_OCR_COLS * ACE_OCR_ROWS).fill(0x20);
  lines.forEach((text, row) => {
    for (let col = 0; col < text.length && col < ACE_OCR_COLS; col++) {
      const code = text.charCodeAt(col);
      vram[row * ACE_OCR_COLS + col] = inverseRows.includes(row) ? code | 0x80 : code;
    }
  });
  return vram;
}

describe('aceScreenText', () => {
  it('reads the screen file back as text', () => {
    expect(aceScreenText(screenOf(['Ready', '', '10 PRINT'])))
      .toBe('Ready\n\n10 PRINT');
  });

  it('reads an inverse-video cell as its own character', () => {
    // Bit 7 is inverse video, not a different character: masking it off is
    // what keeps the ROM's inverse prompt readable.
    expect(aceScreenText(screenOf(['Ready'], [0]))).toBe('Ready');
  });

  it('shows the block graphics as spaces', () => {
    // Codes below 0x20 are the Ace's block-graphics set and have no text
    // meaning, so a graphics screen reads as blank rather than as control
    // characters.
    const vram = screenOf([]);
    vram[0] = 0x05;
    vram[1] = 0x0f;
    expect(aceScreenText(vram)).toBe('');
  });

  it('keeps leading blank lines but trims trailing ones', () => {
    expect(aceScreenText(screenOf(['', '', 'here']))).toBe('\n\nhere');
  });

  it('pads a short screen file rather than reading off the end', () => {
    expect(aceScreenText(new Uint8Array(4))).toBe('');
  });
});

describe('aceScreenCells', () => {
  it('masks printable cells and leaves the graphics unmasked', () => {
    const vram = screenOf(['A']);
    vram[1] = 0x05;                       // a block-graphics cell
    const cells = aceScreenCells(vram);
    expect(cells.mask[0]).toBe(true);     // 'A' may be blanked by the overlay
    expect(cells.mask[1]).toBe(false);    // the graphic stays as picture
    expect(cells.mask[2]).toBe(true);     // a space may be blanked
  });

  it('reports inverse video separately from the character', () => {
    const cells = aceScreenCells(screenOf(['Hi'], [0]));
    expect(cells.chars.slice(0, 2).join('')).toBe('Hi');
    expect(cells.inverse[0]).toBe(true);
    expect(cells.inverse[ACE_OCR_COLS]).toBe(false);
  });

  it('covers the whole 32x24 screen file', () => {
    const cells = aceScreenCells(screenOf([]));
    expect(cells.cols).toBe(32);
    expect(cells.rows).toBe(24);
    expect(cells.chars).toHaveLength(32 * 24);
  });
});

describe('aceOcrResult', () => {
  it('emits full-width rows and the Ace grid', () => {
    const result = aceOcrResult(aceScreenCells(screenOf(['Hi'])));
    expect(result.grid).toBe('32x24');
    expect(result.cols).toBe(32);
    expect(result.rows).toBe(24);
    // Rows keep their full width so the overlay lines up with the picture.
    expect(result.text.split('\n')[0]).toHaveLength(32);
    expect(result.text.split('\n')).toHaveLength(24);
  });

  it('paints an inverse run white on black', () => {
    const result = aceOcrResult(aceScreenCells(screenOf(['Hi'], [0])));
    expect(result.html).toContain('color:#ffffff;background:#000000');
  });

  it('escapes markup characters it transcribes', () => {
    const result = aceOcrResult(aceScreenCells(screenOf(['<&>'])));
    expect(result.html).toContain('&lt;&amp;&gt;');
    expect(result.text.startsWith('<&>')).toBe(true);
  });
});
