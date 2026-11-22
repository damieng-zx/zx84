/**
 * Acorn teletext VDU card: MC6845 CRTC driving 1K of character RAM into an
 * SAA5050 character generator.
 *
 * The CRTC sequences the raster and puts the refresh address (MA) on the
 * character RAM; the byte it fetches is the SAA5050's display byte. For a
 * whole-frame renderer the registers are all that matter: R1 characters per
 * line, R6 lines, R12/R13 the screen base (which is how the COS scrolls), and
 * R14/R15 the hardware cursor.
 *
 * The SAA5050's cell is 6 dots by 10 lines, and it rounds diagonals at twice
 * the horizontal resolution, so each cell is drawn 12 x 10 — one frame-buffer
 * line per scanline, as the BBC's Mode 7 does.
 */

import { Saa5050, createSaa5050Cells, type Saa5050Cell } from '@/cores/saa5050.ts';
import type { Crtc6845 } from '@/cores/crtc-6845.ts';
import {
  ACORN_SYSTEM_BORDER_LEFT, ACORN_SYSTEM_BORDER_TOP, ACORN_SYSTEM_CELL_HEIGHT,
  ACORN_SYSTEM_CELL_WIDTH, ACORN_SYSTEM_COLS, ACORN_SYSTEM_SCREEN_HEIGHT,
  ACORN_SYSTEM_SCREEN_WIDTH,
} from './constants.ts';

const BLACK = 0xFF000000;

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
  readonly pixels = new Uint8Array(
    ACORN_SYSTEM_SCREEN_WIDTH * ACORN_SYSTEM_SCREEN_HEIGHT * 4,
  );
  private readonly pixels32 = new Uint32Array(this.pixels.buffer);
  private readonly saa = new Saa5050();
  private readonly cells: Saa5050Cell[] = createSaa5050Cells(ACORN_SYSTEM_COLS);
  private readonly rowChars = new Uint8Array(ACORN_SYSTEM_COLS);

  /** SAA5050 palette family, from the Display pane's Colour map choice. */
  paletteMode: 'pal' | 'measured' = 'pal';

  constructor() {
    this.pixels32.fill(BLACK);
  }

  reset(): void {
    this.saa.reset();
  }

  /**
   * Draw the whole screen from the CRTC's registers and the character RAM.
   * `cursorOn` is the cursor's blink phase (steady cursors ignore it).
   */
  render(crtc: Crtc6845, videoRam: Uint8Array, cursorOn: boolean): void {
    const regs = crtc.regs;
    const cols = Math.min(ACORN_SYSTEM_COLS, regs[R_HORIZ_DISPLAYED] || ACORN_SYSTEM_COLS);
    const rows = Math.min(
      ACORN_SYSTEM_SCREEN_HEIGHT / ACORN_SYSTEM_CELL_HEIGHT,
      regs[R_VERT_DISPLAYED] || 25,
    );
    const start = crtc.displayStart & (videoRam.length - 1);
    const cursorAddr = (((regs[R_CURSOR_H] & 0x3F) << 8) | regs[R_CURSOR_L]) & (videoRam.length - 1);
    const cursorStart = regs[R_CURSOR_START] & 0x1F;
    const cursorEnd = regs[R_CURSOR_END] & 0x1F;
    const palette = this.paletteMode === 'measured' ? MEASURED_PALETTE32 : PAL_PALETTE32;
    const px = this.pixels32;

    px.fill(BLACK);
    this.saa.reset();
    for (let row = 0; row < rows; row++) {
      const rowBase = (start + row * cols) & (videoRam.length - 1);
      for (let c = 0; c < cols; c++) this.rowChars[c] = videoRam[(rowBase + c) & (videoRam.length - 1)];
      this.saa.renderRow(this.rowChars, cols, this.cells);

      const y0 = ACORN_SYSTEM_BORDER_TOP + row * ACORN_SYSTEM_CELL_HEIGHT;
      for (let c = 0; c < cols; c++) {
        const cell = this.cells[c];
        const fg = palette[cell.fg & 7];
        const bg = palette[cell.bg & 7];
        const x0 = ACORN_SYSTEM_BORDER_LEFT + c * ACORN_SYSTEM_CELL_WIDTH;
        const cursorCell = ((rowBase + c) & (videoRam.length - 1)) === cursorAddr;
        for (let k = 0; k < ACORN_SYSTEM_CELL_HEIGHT; k++) {
          const bits = cell.pixels[k * 2];
          const base = (y0 + k) * ACORN_SYSTEM_SCREEN_WIDTH + x0;
          // The cursor is an underline on the scanlines R10..R11 name; the
          // raster address steps by two in the interlace the 40x25 card uses.
          const ra = k * 2;
          const cursorLine = cursorOn && cursorCell && ra >= cursorStart && ra <= cursorEnd;
          for (let d = 0; d < ACORN_SYSTEM_CELL_WIDTH; d++) {
            px[base + d] = cursorLine ? fg : ((bits >> d) & 1) !== 0 ? fg : bg;
          }
        }
      }
    }
  }
}
