/**
 * Acorn System text transcription.
 *
 * The screen is already a character matrix, so there is nothing to recognise:
 * the overlay reads the display bytes the CRTC is showing. On the teletext card
 * a cell's ink and paper come from the SAA5050 (the control bytes that set them
 * share the same 1K as the text); the 80x25 card is a monochrome character
 * generator, so every cell is white on black.
 */

import { Saa5050, createSaa5050Cells, type Saa5050Cell } from '@/cores/saa5050.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import type { Crtc6845 } from '@/cores/crtc-6845.ts';
import type { AcornSystemVduConfig } from './constants.ts';

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
  private readonly cells: Saa5050Cell[] = createSaa5050Cells(80);
  private readonly rowChars = new Uint8Array(80);

  /** The screen as the CRTC's window shows it: text, coloured HTML and a mask. */
  ocr(videoRam: Uint8Array, crtc: Crtc6845, vdu: AcornSystemVduConfig): OcrResult {
    const regs = crtc.regs;
    const cols = Math.min(vdu.cols, regs[1] || vdu.cols);
    const rows = Math.min(vdu.rows, regs[6] || vdu.rows);
    const mask = videoRam.length - 1;
    const start = crtc.displayStart & mask;
    const teletext = vdu.cols === 40;
    const cells = new Array<boolean>(cols * rows).fill(false);
    const paper: number[] = new Array(cols * rows).fill(0);
    const textLines: string[] = [];
    const htmlLines: string[] = [];

    this.saa.reset();
    for (let row = 0; row < rows; row++) {
      const rowBase = (start + row * cols) & mask;
      for (let c = 0; c < cols; c++) this.rowChars[c] = videoRam[(rowBase + c) & mask];
      if (teletext) this.saa.renderRow(this.rowChars, cols, this.cells);

      let text = '';
      let html = '';
      for (let c = 0; c < cols; c++) {
        const ch = displayChar(this.rowChars[c]);
        const i = row * cols + c;
        cells[i] = ch !== ' ';
        const fg = teletext ? COLOURS[this.cells[c].fg & 7] : '#ffffff';
        const bg = teletext ? COLOURS[this.cells[c].bg & 7] : '#000000';
        paper[i] = teletext ? this.cells[c].bg : 0;
        text += ch;
        html += `<span style="color:${fg};background:${bg}">${escape(ch)}</span>`;
      }
      textLines.push(text);
      htmlLines.push(`<div>${html}</div>`);
    }

    return {
      text: textLines.join('\n'),
      html: htmlLines.join(''),
      mask: cells,
      paper,
      grid: `${cols}x${rows}`,
      cellWidth: vdu.cellWidth,
      cellHeight: vdu.cellHeight,
      cols,
      rows,
    };
  }
}
