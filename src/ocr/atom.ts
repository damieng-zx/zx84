/**
 * Acorn Atom text transcription.
 *
 * The 6847's alphanumeric mode stores one display code per 8x12 cell at
 * $8000-$81FF. The Atom's codes are not ASCII: $00-$1F are '@', A-Z, [ \ ] and
 * the two arrow glyphs (the codes the OS maps ASCII $40-$5F to); $20-$3F are
 * ASCII as-is; $80-$BF repeat the first two ranges inverted. $40-$7F and
 * $C0-$FF are semigraphics, which have no text.
 */

import type { OcrResult } from '@/ocr/ocr.ts';
import { ATOM_TEXT_COLS, ATOM_TEXT_ROWS } from '@/machines/atom/constants.ts';

const CELL_WIDTH = 8;
const CELL_HEIGHT = 12;

/** The ASCII character a display code shows, or null for a graphics cell. */
export function atomCodeToAscii(code: number): string | null {
  const c = (code & 0xFF) >= 0x80 && (code & 0xFF) < 0xC0 ? (code & 0x3F) : (code & 0xFF);
  if (c < 0x20) return String.fromCharCode(c + 0x40);
  if (c < 0x40) return String.fromCharCode(c);
  return null;
}

/** A display code is inverse video (the OS's lower-case/inverse range). */
export function atomCodeIsInverse(code: number): boolean {
  return (code & 0xFF) >= 0x80 && (code & 0xFF) < 0xC0;
}

function escape(ch: string): string {
  return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
}

/** `screen` holds 512 display codes, row-major, starting at $8000. */
export function ocrAtomText(screen: Uint8Array, ink = '#30d200'): OcrResult {
  const mask: boolean[] = new Array(ATOM_TEXT_COLS * ATOM_TEXT_ROWS).fill(false);
  const textLines: string[] = [];
  const htmlLines: string[] = [];
  for (let row = 0; row < ATOM_TEXT_ROWS; row++) {
    let text = '';
    let html = '';
    for (let col = 0; col < ATOM_TEXT_COLS; col++) {
      const at = row * ATOM_TEXT_COLS + col;
      const code = screen[at] ?? 0x20;
      const ch = atomCodeToAscii(code);
      const printable = ch ?? ' ';
      mask[at] = printable !== ' ';
      text += printable;
      const inverse = ch !== null && atomCodeIsInverse(code);
      html += `<span${inverse ? ' style="background:' + ink + ';color:#000"' : ''}>${escape(printable)}</span>`;
    }
    textLines.push(text);
    htmlLines.push(`<div style="color:${ink}">${html}</div>`);
  }
  return {
    text: textLines.join('\n'),
    html: htmlLines.join(''),
    mask,
    grid: '32x16',
    cellWidth: CELL_WIDTH,
    cellHeight: CELL_HEIGHT,
    cols: ATOM_TEXT_COLS,
    rows: ATOM_TEXT_ROWS,
  };
}
