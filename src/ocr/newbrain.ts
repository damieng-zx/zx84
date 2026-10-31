/**
 * Grundy NewBrain screen OCR.
 *
 * Like the Jupiter Ace, the NewBrain keeps character codes in RAM — the video
 * circuit reads one byte per cell and looks the glyph up as it draws — so the
 * text is read straight out of the screen buffer, no font matching needed.
 * `machines/newbrain/newbrain-video.ts` knows the row layout; this adapts its
 * cells to the shared overlay result.
 *
 * The picture is monochrome: light dots on a dark ground, or the other way
 * round with the reverse-video bit set.
 */

import type { OcrResult } from './ocr.ts';
import type { NewBrainScreenCells } from '@/machines/newbrain/newbrain-video.ts';

const LIGHT = '#e6e6e6';
const DARK = '#000000';

function escapeHtml(ch: string): string {
  return ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
}

/** The cells shaped for the TEXT overlay: the whole grid, rows kept at full
 *  width so the overlay scales to the picture predictably. */
export function newBrainOcrResult(cells: NewBrainScreenCells): OcrResult {
  const style = cells.reverse ? `color:${DARK};background:${LIGHT}` : `color:${LIGHT}`;
  let text = '';
  let html = '';
  for (let r = 0; r < cells.rows; r++) {
    let line = '';
    let span = '';
    for (let c = 0; c < cells.cols; c++) {
      const ch = cells.chars[r * cells.cols + c];
      line += ch;
      span += escapeHtml(ch);
    }
    text += line;
    html += `<span style="${style}">${span}</span>`;
    if (r < cells.rows - 1) { text += '\n'; html += '\n'; }
  }
  return {
    text,
    html,
    mask: cells.mask,
    grid: `${cells.cols}x${cells.rows}` as OcrResult['grid'],
    cellWidth: 640 / cells.cols,
    cellHeight: cells.cellHeight,
    cols: cells.cols,
    rows: cells.rows,
  };
}
