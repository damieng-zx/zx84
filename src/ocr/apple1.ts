/**
 * Apple I text transcription.
 *
 * The screen is a terminal with the text already in a buffer, so there is
 * nothing to recognise: the overlay reads the characters straight from it.
 */

import type { OcrResult } from '@/ocr/ocr.ts';

export const APPLE1_OCR_COLS = 40;
export const APPLE1_OCR_ROWS = 24;
const CELL_WIDTH = 7;
const CELL_HEIGHT = 8;

function escape(ch: string): string {
  return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
}

/** `cells` holds one character code ($20-$5F) per terminal cell, row-major. */
export function ocrApple1Text(cells: Uint8Array, ink = '#ffffff'): OcrResult {
  const mask: boolean[] = new Array(APPLE1_OCR_COLS * APPLE1_OCR_ROWS).fill(false);
  const textLines: string[] = [];
  const htmlLines: string[] = [];
  for (let row = 0; row < APPLE1_OCR_ROWS; row++) {
    let text = '';
    let html = '';
    for (let col = 0; col < APPLE1_OCR_COLS; col++) {
      const ch = String.fromCharCode(cells[row * APPLE1_OCR_COLS + col]);
      mask[row * APPLE1_OCR_COLS + col] = ch !== ' ';
      text += ch;
      html += `<span>${escape(ch)}</span>`;
    }
    textLines.push(text);
    htmlLines.push(`<div style="color:${ink}">${html}</div>`);
  }
  return {
    text: textLines.join('\n'),
    html: htmlLines.join(''),
    mask,
    grid: '40x24',
    cellWidth: CELL_WIDTH,
    cellHeight: CELL_HEIGHT,
    cols: APPLE1_OCR_COLS,
    rows: APPLE1_OCR_ROWS,
  };
}
