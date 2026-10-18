/**
 * Apple II screen OCR.
 *
 * The text screen is an array of character cells (40 columns, or 80 on a //e
 * with the 80-column switch on) backing the same memory lores uses, so — unlike
 * the bitmap machines — recognition is exact: each screen byte names a glyph
 * directly. The ][+ order runs `@A-Z[\]^_` for codes $00-$1F and ASCII
 * space…`?` for $20-$3F; bit 7 is inverse video and bit 6 flash, both of which
 * read as the same glyph. The //e's alternate character set adds lowercase.
 *
 * The grid is always the full text area (so the overlay lines up with the
 * screen); rows not currently showing text — the top of a mixed-mode display —
 * come back blank and unmasked.
 */

import type { OcrResult } from './ocr.ts';
import { textRowBase } from '@/machines/apple2/apple2-video.ts';
import { APPLE2_ACTIVE_WIDTH } from '@/machines/apple2/constants.ts';

export const APPLE2_OCR_COLS = 40;
export const APPLE2_OCR_ROWS = 24;
export const APPLE2_OCR_CELL_H = 8;

/** The character a ][/][+ screen byte displays (ignoring inverse/flash). */
export function apple2Char(byte: number): string {
  const code = byte & 0x3F;
  return String.fromCharCode(code < 0x20 ? code + 0x40 : code);
}

/**
 * The character a //e screen byte displays. With the alternate character set
 * on, `$60-$7F` and `$E0-$FF` are lowercase; with it off they show what a ][+
 * would (flashing symbols, and upper case for the normal range).
 */
export function apple2eChar(byte: number, altCharset: boolean): string {
  const c = byte & 0x7F;
  if (c < 0x20) return String.fromCharCode(c + 0x40);
  if (c < 0x60) return String.fromCharCode(c);
  if (altCharset) return String.fromCharCode(c);
  return String.fromCharCode(byte >= 0x80 ? c - 0x20 : c - 0x40);
}

export interface Apple2OcrInput {
  readonly ram: Uint8Array;
  readonly page2: boolean;
  /** Inclusive text-row range on display, or null when only graphics shows. */
  readonly textRows: { readonly first: number; readonly last: number } | null;
  /** //e: auxiliary RAM (even columns in 80-column text), if fitted. */
  readonly aux?: Uint8Array | null;
  /** //e: 80-column text is on. */
  readonly col80?: boolean;
  /** //e: the alternate (lowercase) character set is on. */
  readonly altCharset?: boolean;
  /** A //e: decode with the //e's character set. */
  readonly iie?: boolean;
  /** A Videx Videoterm's screen: `ram` is the card's RAM, read as 80 columns from `start`. */
  readonly videx?: { readonly start: number };
}

function escape(ch: string): string {
  return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
}

export function ocrApple2Text(input: Apple2OcrInput): OcrResult {
  const page = input.page2 ? 'page2' : 'page1';
  const cols = input.col80 || input.videx ? 80 : APPLE2_OCR_COLS;
  const mask: boolean[] = new Array(cols * APPLE2_OCR_ROWS).fill(false);
  const paper: number[] = new Array(cols * APPLE2_OCR_ROWS).fill(0);
  const textLines: string[] = [];
  const htmlLines: string[] = [];
  const decode = (byte: number): string => {
    if (input.videx) return byte < 0x20 ? ' ' : String.fromCharCode(byte);
    return input.iie ? apple2eChar(byte, !!input.altCharset) : apple2Char(byte);
  };

  for (let row = 0; row < APPLE2_OCR_ROWS; row++) {
    const inText = input.textRows !== null
      && row >= input.textRows.first && row <= input.textRows.last;
    const addr = input.videx ? input.videx.start + row * 80 : textRowBase(page, row);
    let text = '';
    let html = '';
    for (let c = 0; c < cols; c++) {
      if (!inText) { text += ' '; html += '<span> </span>'; continue; }
      let byte: number;
      if (input.videx) {
        byte = input.ram[(addr + c) & 0x7FF] & 0x7F;           // 7-bit ASCII; bit 7 is inverse
      } else if (input.col80) {
        const bank = (c & 1) === 0 ? (input.aux ?? null) : input.ram;
        byte = bank ? bank[(addr + (c >> 1)) & 0xFFFF] : 0xA0;
      } else {
        byte = input.ram[(addr + c) & 0xFFFF];
      }
      const ch = decode(byte);
      mask[row * cols + c] = true;
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
    grid: `${cols}x${APPLE2_OCR_ROWS}`,
    cellWidth: APPLE2_ACTIVE_WIDTH / cols,
    cellHeight: input.videx ? 9 : APPLE2_OCR_CELL_H,
    cols,
    rows: APPLE2_OCR_ROWS,
  };
}
