/**
 * The System's VDU cards.
 *
 * `teletext40` — the 40x25 teletext card: an MC6845 CRTC driving 1K of
 * character RAM into an SAA5050. The chip rounds diagonals at twice the
 * horizontal resolution, so a cell is drawn 12 x 10.
 *
 * `mono80` — the 80x25 character card: 2K of character RAM at &1000, the CRTC at
 * &1840, and a character-generator ROM of 8x8 glyphs clocked at 12 MHz. Ten
 * scanlines per row, so the glyph sits in the top eight and the cursor in the
 * rest.
 *
 * Both cards are memory-mapped and read their own RAM, so the picture is drawn
 * whole at the end of the frame; the CRTC's registers are the only state that
 * matters (R1/R6 the grid, R12/R13 the screen base, R14/R15 and R10/R11 the
 * cursor).
 */

import { Saa5050, createSaa5050Cells, type Saa5050Cell } from '@/cores/saa5050.ts';
import type { Crtc6845 } from '@/cores/crtc-6845.ts';
import type { AcornSystemVduConfig } from './constants.ts';

const BLACK = 0xFF000000;
const WHITE = 0xFFFFFFFF;

/** SAA5050 colours 0-7 as packed little-endian RGBA: PAL levels, then measured. */
const PAL_PALETTE32 = Uint32Array.from([
  0xFF000000, 0xFF0000FF, 0xFF00FF00, 0xFF00FFFF,
  0xFFFF0000, 0xFFFF00FF, 0xFFFFFF00, 0xFFFFFFFF,
]);
const MEASURED_PALETTE32 = Uint32Array.from([
  0xFF000000, 0xFF0000C0, 0xFF00C000, 0xFF00C0C0,
  0xFFC00000, 0xFFC000C0, 0xFFC0C000, 0xFFE0E0E0,
]);

/** 6845 register indices used here. */
const R_HORIZ_DISPLAYED = 1;
const R_VERT_DISPLAYED = 6;
const R_CURSOR_START = 10;
const R_CURSOR_END = 11;
const R_CURSOR_H = 14;
const R_CURSOR_L = 15;

export class AcornSystemVideo {
  readonly pixels: Uint8Array;
  private readonly pixels32: Uint32Array;
  private readonly vdu: AcornSystemVduConfig;
  private readonly mono: boolean;

  // Teletext card
  private readonly saa = new Saa5050();
  private readonly cells: Saa5050Cell[];
  private readonly rowChars: Uint8Array;
  /** SAA5050 palette family, from the Display pane's Colour map choice. */
  paletteMode: 'pal' | 'measured' = 'pal';

  // 80x25 card
  /**
   * The character-generator ROM: 128 glyphs of 16 bytes. The first ten rows of
   * each block are the cell — eight for the glyph body and two more for a
   * descender — and the remaining six are unused. Indexing at 8 bytes instead
   * lands mid-block and draws the wrong character.
   */
  private font: Uint8Array | null = null;

  constructor(vdu: AcornSystemVduConfig, kind: 'teletext40' | 'mono80') {
    this.vdu = vdu;
    this.mono = kind === 'mono80';
    this.pixels = new Uint8Array(vdu.width * vdu.height * 4);
    this.pixels32 = new Uint32Array(this.pixels.buffer);
    this.cells = createSaa5050Cells(vdu.cols);
    this.rowChars = new Uint8Array(vdu.cols);
    this.pixels32.fill(BLACK);
  }

  /** Install the 80x25 card's character generator. */
  setFont(data: Uint8Array): void {
    this.font = data.slice(0, 2048);
  }

  get hasFont(): boolean { return this.font !== null; }

  reset(): void {
    this.saa.reset();
  }

  /**
   * Draw the whole screen from the CRTC's registers and the character RAM.
   * `cursorOn` is the cursor's blink phase (steady cursors ignore it).
   */
  render(crtc: Crtc6845, videoRam: Uint8Array, cursorOn: boolean): void {
    if (this.mono) this.renderMono(crtc, videoRam, cursorOn);
    else this.renderTeletext(crtc, videoRam, cursorOn);
  }

  private renderTeletext(crtc: Crtc6845, videoRam: Uint8Array, cursorOn: boolean): void {
    const regs = crtc.regs;
    const cols = Math.min(this.vdu.cols, regs[R_HORIZ_DISPLAYED] || this.vdu.cols);
    const rows = Math.min(this.vdu.rows, regs[R_VERT_DISPLAYED] || this.vdu.rows);
    const mask = videoRam.length - 1;
    const start = crtc.displayStart & mask;
    const cursorAddr = (((regs[R_CURSOR_H] & 0x3F) << 8) | regs[R_CURSOR_L]) & mask;
    const cursorStart = regs[R_CURSOR_START] & 0x1F;
    const cursorEnd = regs[R_CURSOR_END] & 0x1F;
    const palette = this.paletteMode === 'measured' ? MEASURED_PALETTE32 : PAL_PALETTE32;
    const px = this.pixels32;
    const { width, cellWidth, cellHeight, borderLeft, borderTop } = this.vdu;

    px.fill(BLACK);
    this.saa.reset();
    for (let row = 0; row < rows; row++) {
      const rowBase = (start + row * cols) & mask;
      for (let c = 0; c < cols; c++) this.rowChars[c] = videoRam[(rowBase + c) & mask];
      this.saa.renderRow(this.rowChars, cols, this.cells);

      const y0 = borderTop + row * cellHeight;
      for (let c = 0; c < cols; c++) {
        const cell = this.cells[c];
        const fg = palette[cell.fg & 7];
        const bg = palette[cell.bg & 7];
        const x0 = borderLeft + c * cellWidth;
        const cursorCell = ((rowBase + c) & mask) === cursorAddr;
        for (let k = 0; k < cellHeight; k++) {
          const bits = cell.pixels[k * 2];
          const base = (y0 + k) * width + x0;
          // The cursor is an underline on the scanlines R10..R11 name; the
          // raster address steps by two in the interlace this card uses.
          const ra = k * 2;
          const cursorLine = cursorOn && cursorCell && ra >= cursorStart && ra <= cursorEnd;
          for (let d = 0; d < cellWidth; d++) {
            px[base + d] = cursorLine ? fg : ((bits >> d) & 1) !== 0 ? fg : bg;
          }
        }
      }
    }
  }

  private renderMono(crtc: Crtc6845, videoRam: Uint8Array, cursorOn: boolean): void {
    const regs = crtc.regs;
    const cols = Math.min(this.vdu.cols, regs[R_HORIZ_DISPLAYED] || this.vdu.cols);
    const rows = Math.min(this.vdu.rows, regs[R_VERT_DISPLAYED] || this.vdu.rows);
    const mask = videoRam.length - 1;
    const start = crtc.displayStart & mask;
    const cursorAddr = (((regs[R_CURSOR_H] & 0x3F) << 8) | regs[R_CURSOR_L]) & mask;
    const cursorStart = regs[R_CURSOR_START] & 0x1F;
    const cursorEnd = regs[R_CURSOR_END] & 0x1F;
    const font = this.font;
    const px = this.pixels32;
    const { width, cellWidth, cellHeight, borderLeft, borderTop } = this.vdu;

    px.fill(BLACK);
    if (font === null) return;

    for (let row = 0; row < rows; row++) {
      const rowBase = (start + row * cols) & mask;
      const y0 = borderTop + row * cellHeight;
      for (let c = 0; c < cols; c++) {
        const cellAddr = (rowBase + c) & mask;
        const code = videoRam[cellAddr] & 0x7F;
        const glyph = code * 16;
        const x0 = borderLeft + c * cellWidth;
        const cursorCell = cursorOn && cellAddr === cursorAddr;
        for (let k = 0; k < cellHeight; k++) {
          const base = (y0 + k) * width + x0;
          const cursorLine = cursorCell && k >= cursorStart && k <= cursorEnd;
          if (cursorLine) {
            for (let d = 0; d < cellWidth; d++) px[base + d] = WHITE;
            continue;
          }
          // Eight rows of glyph body, then the two descender rows the card
          // reserves below it; a tenth scanline past the block is blank.
          const bits = k < 10 ? font[glyph + k] : 0;
          if (bits === 0) continue;
          for (let d = 0; d < cellWidth; d++) {
            if ((bits >> (7 - d)) & 1) px[base + d] = WHITE;
          }
        }
      }
    }
  }
}
