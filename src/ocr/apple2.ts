/**
 * Apple II screen OCR.
 *
 * The text screen is a 40×24 array of character cells backing the same memory
 * lores uses, so — unlike the bitmap machines — recognition is exact: each
 * screen byte's low six bits name a glyph directly. The Apple II character
 * order runs `@A-Z[\]^_` for codes $00-$1F and ASCII space…`?` for $20-$3F;
 * bit 7 is inverse video and bit 6 flash, both of which read as the same glyph.
 *
 * The grid is always the full 40×24 text area (so the overlay lines up with the
 * screen); rows not currently showing text — the top of a mixed-mode display —
 * come back blank and unmasked.
 */

import type { OcrResult } from './ocr.ts';
import { textRowBase } from '@/machines/apple2/apple2-video.ts';

export const APPLE2_OCR_COLS = 40;
export const APPLE2_OCR_ROWS = 24;
export const APPLE2_OCR_CELL_W = 7;
export const APPLE2_OCR_CELL_H = 8;

/** The character a screen byte displays (ignoring inverse/flash). */
export function apple2Char(byte: number): string {
  const code = byte & 0x3F;
  return String.fromCharCode(code < 0x20 ? code + 0x40 : code);
}

export interface Apple2OcrInput {
  readonly ram: Uint8Array;
  readonly page2: boolean;
  /** Inclusive text-row range on display, or null when only graphics shows. */
  readonly textRows: { readonly first: number; readonly last: number } | null;
}

function escape(ch: string): string {
  return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
}

export function ocrApple2Text(input: Apple2OcrInput): OcrResult {
  const page = input.page2 ? 'page2' : 'page1';
  const mask: boolean[] = new Array(APPLE2_OCR_COLS * APPLE2_OCR_ROWS).fill(false);
  const paper: number[] = new Array(APPLE2_OCR_COLS * APPLE2_OCR_ROWS).fill(0);
  const textLines: string[] = [];
  const htmlLines: string[] = [];

  for (let row = 0; row < APPLE2_OCR_ROWS; row++) {
    const inText = input.textRows !== null
      && row >= input.textRows.first && row <= input.textRows.last;
    const addr = textRowBase(page, row);
    let text = '';
    let html = '';
    for (let c = 0; c < APPLE2_OCR_COLS; c++) {
      if (!inText) { text += ' '; html += '<span> </span>'; continue; }
      const ch = apple2Char(input.ram[(addr + c) & 0xFFFF]);
      mask[row * APPLE2_OCR_COLS + c] = true;
      text += ch;
      html += `<span>${escape(ch)}</span>`;
    }
    textLines.push(text);
    htmlLines.push(`<div>${html}</div>`);
  }

  return {
    text: textLines.join('\n'),
    html: htmlLines.join(''),
    mask,
    paper,
    grid: '40x24',
    cellWidth: APPLE2_OCR_CELL_W,
    cellHeight: APPLE2_OCR_CELL_H,
    cols: APPLE2_OCR_COLS,
    rows: APPLE2_OCR_ROWS,
  };
}
