/**
 * Acorn System 2 text transcription.
 *
 * The teletext card's screen is already a character matrix, so there is nothing
 * to recognise: the overlay reads the display bytes the CRTC is showing and
 * takes each cell's foreground and background from the SAA5050, which is the
 * only way to know what colour a cell is (the control bytes that set it share
 * the same 1K as the text).
 */

import { Saa5050, createSaa5050Cells, type Saa5050Cell } from '@/cores/saa5050.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import type { Crtc6845 } from '@/cores/crtc-6845.ts';

const COLS = 40;
const ROWS = 25;
const CELL_WIDTH = 12;
const CELL_HEIGHT = 10;

/** SAA5050 colour 0-7 as CSS. */
const COLOURS = [
  '#000000', '#ff5555', '#55ff55', '#ffff55',
  '#5555ff', '#ff55ff', '#55ffff', '#ffffff',
] as const;

function escape(ch: string): string {
  return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
}

/** The character a display byte shows, or a space for a control or mosaic byte. */
function displayChar(byte: number): string {
  const code = byte & 0x7F;
  return code >= 0x20 && code < 0x7F ? String.fromCharCode(code) : ' ';
}

export class AcornSystemScreenText {
  private readonly saa = new Saa5050();
  private readonly cells: Saa5050Cell[] = createSaa5050Cells(COLS);
  private readonly rowChars = new Uint8Array(COLS);

  /** The screen as the CRTC's window shows it: text, coloured HTML and a mask. */
  ocr(videoRam: Uint8Array, crtc: Crtc6845): OcrResult {
    const regs = crtc.regs;
    const cols = Math.min(COLS, regs[1] || COLS);
    const rows = Math.min(ROWS, regs[6] || ROWS);
    const start = crtc.displayStart & (videoRam.length - 1);
    const mask: boolean[] = new Array(cols * rows).fill(false);
    const paper: number[] = new Array(cols * rows).fill(0);
    const textLines: string[] = [];
    const htmlLines: string[] = [];

    this.saa.reset();
    for (let row = 0; row < rows; row++) {
      const rowBase = (start + row * cols) & (videoRam.length - 1);
      for (let c = 0; c < cols; c++) this.rowChars[c] = videoRam[(rowBase + c) & (videoRam.length - 1)];
      this.saa.renderRow(this.rowChars, cols, this.cells);

      let text = '';
      let html = '';
      for (let c = 0; c < cols; c++) {
        const cell = this.cells[c];
        const ch = displayChar(this.rowChars[c]);
        const i = row * cols + c;
        mask[i] = ch !== ' ';
        paper[i] = cell.bg;
        text += ch;
        html += `<span style="color:${COLOURS[cell.fg & 7]};background:${COLOURS[cell.bg & 7]}">${escape(ch)}</span>`;
      }
      textLines.push(text);
      htmlLines.push(`<div>${html}</div>`);
    }

    return {
      text: textLines.join('\n'),
      html: htmlLines.join(''),
      mask,
      paper,
      grid: '40x25',
      cellWidth: CELL_WIDTH,
      cellHeight: CELL_HEIGHT,
      cols,
      rows,
    };
  }
}
