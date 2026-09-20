/**
 * Jupiter Ace screen OCR.
 *
 * The Ace is the easy case. Its 1KB screen file at 0x2000 is a 32x24 grid of
 * character codes, so the text is already there to be read — no font matching
 * is needed and a program that redefines the character set (the Ace's 1KB of
 * character RAM at 0x2800 is writable) does not change what the codes say.
 *
 * The code set is ASCII for 0x20-0x7F. Bit 7 is inverse video rather than a
 * different character, so it is masked off for the text and reported
 * separately, which is what lets the overlay paint an inverse cell the right
 * way round. Codes below 0x20 are the Ace's block-graphics set; they have no
 * text meaning, so they read as spaces and are left unmasked so the TEXT
 * overlay keeps showing the picture underneath.
 */

import type { OcrResult } from './ocr.ts';

export const ACE_OCR_COLS = 32;
export const ACE_OCR_ROWS = 24;

/** One transcribed screen, the full untrimmed grid. */
export interface AceOcrCells {
  /** One entry per cell, row-major. */
  chars: string[];
  /** True where the cell held a printable character, so the overlay may blank
   *  it. False for the block graphics, which stay as picture. */
  mask: boolean[];
  /** True where the cell was stored with bit 7 set: white on black. */
  inverse: boolean[];
  cols: number;
  rows: number;
}

/** Cut the screen file into cells. `vram` is the 1KB screen file; anything
 *  shorter is padded with blanks rather than read off the end. */
export function aceScreenCells(vram: Uint8Array): AceOcrCells {
  const count = ACE_OCR_COLS * ACE_OCR_ROWS;
  const chars: string[] = new Array(count);
  const mask: boolean[] = new Array(count);
  const inverse: boolean[] = new Array(count);

  for (let idx = 0; idx < count; idx++) {
    const value = idx < vram.length ? vram[idx] : 0x20;
    const code = value & 0x7f;
    const printable = code >= 0x20 && code < 0x7f;
    chars[idx] = printable ? String.fromCharCode(code) : ' ';
    mask[idx] = printable;
    inverse[idx] = (value & 0x80) !== 0;
  }
  return { chars, mask, inverse, cols: ACE_OCR_COLS, rows: ACE_OCR_ROWS };
}

/** Plain text, trailing blanks trimmed. Leading blank lines are screen
 *  position and are kept. */
export function aceScreenText(vram: Uint8Array): string {
  const cells = aceScreenCells(vram);
  const lines: string[] = [];
  for (let row = 0; row < cells.rows; row++) {
    const from = row * cells.cols;
    lines.push(cells.chars.slice(from, from + cells.cols).join('').replace(/\s+$/, ''));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value === '<' ? '&lt;' : value === '>' ? '&gt;' : value === '&' ? '&amp;' : value;
}

/** Black ink on white paper, the Ace's normal way round; inverse cells swap. */
const INK = '#000000';
const PAPER = '#ffffff';

/** The same transcription shaped for the TEXT overlay: the full grid, rows
 *  kept at their full width so the overlay scales to the picture predictably. */
export function aceOcrResult(cells: AceOcrCells): OcrResult {
  let text = '', html = '';
  for (let row = 0; row < cells.rows; row++) {
    const from = row * cells.cols;
    let span = '', inverse: boolean | null = null;
    for (let col = 0; col < cells.cols; col++) {
      const idx = from + col;
      if (cells.inverse[idx] !== inverse) {
        if (span !== '') {
          html += inverse
            ? `<span style="color:${PAPER};background:${INK}">${span}</span>`
            : `<span style="color:${INK}">${span}</span>`;
        }
        span = ''; inverse = cells.inverse[idx];
      }
      span += escapeHtml(cells.chars[idx]);
      text += cells.chars[idx];
    }
    if (span !== '') {
      html += inverse
        ? `<span style="color:${PAPER};background:${INK}">${span}</span>`
        : `<span style="color:${INK}">${span}</span>`;
    }
    if (row < cells.rows - 1) { text += '\n'; html += '\n'; }
  }
  return {
    text, html, mask: cells.mask, grid: '32x24',
    cellWidth: 8, cellHeight: 8, cols: cells.cols, rows: cells.rows,
  };
}
