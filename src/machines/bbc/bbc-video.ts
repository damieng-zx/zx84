/**
 * BBC Micro video output.
 *
 * Mode 7 is rendered by the SAA5050 teletext generator. Its rounded 12×20
 * cells are two interlaced fields of 10 lines. At 1x each buffer line blends
 * the pair (50% where only one half-line is lit), as the eye does on a TV; in
 * the hi-res layout (2x and up) all 20 rounded lines are drawn as the chip
 * makes them and the bitmap scanlines are doubled. Modes 0-6 are rendered
 * from the 6845's MA through the video ULA's bit-depth/palette mapping. Both
 * read display RAM directly; the machine owns the frame timing.
 *
 * A frame is drawn one of two ways. `render` draws it whole from the state at
 * the end of the frame (the Low accuracy). `beginFrame` / `drawLine` /
 * `endLine` draw it as the beam goes: the machine calls `drawLine` at the end
 * of each scanline (Mid) and also, at High, just before every write the CPU
 * makes, up to the character the beam has reached, so a mode, palette, CRTC or
 * screen-memory change mid-frame or mid-line shows from where it was made.
 */

import { Saa5050, createSaa5050Cells, type Saa5050Cell } from '@/cores/saa5050.ts';
import {
  BBC_ACTIVE_WIDTH, BBC_BORDER_LEFT, BBC_LAYOUT_1X, BBC_LAYOUT_HIRES, BBC_SCREEN_WIDTH,
  type BbcLayout,
} from './constants.ts';
import type { BbcMachine } from './bbc-machine.ts';

const W = BBC_SCREEN_WIDTH;
const BLACK = 0xFF000000;
/** Mode 7's cell grid: 40 columns of 12 dots, centred in the active area. */
const TELETEXT_COLS = 40;
const CELL_W = 12;

/** Physical BBC colours 0-7 as packed little-endian RGBA. 'pal' is fully
 *  saturated; 'measured' uses the muted levels a real PAL receiver produced. */
const PAL_PALETTE32 = Uint32Array.from([
  0xFF000000, 0xFF0000FF, 0xFF00FF00, 0xFF00FFFF,
  0xFFFF0000, 0xFFFF00FF, 0xFFFFFF00, 0xFFFFFFFF,
]);
const MEASURED_PALETTE32 = Uint32Array.from([
  0xFF000000, 0xFF0000C0, 0xFF00C000, 0xFF00C0C0,
  0xFFC00000, 0xFFC000C0, 0xFFC0C000, 0xFFE0E0E0,
]);

export interface BitmapMode {
  readonly bpp: 1 | 2 | 4;
  /** Active pixel width (640, 320 or 160). */
  readonly width: number;
}

export function bitmapMode(mode: number): BitmapMode {
  switch (mode) {
    case 0: case 3: return { bpp: 1, width: 640 };
    case 1: return { bpp: 2, width: 320 };
    case 2: return { bpp: 4, width: 160 };
    case 5: return { bpp: 2, width: 160 };
    default: return { bpp: 1, width: 320 };   // modes 4 and 6
  }
}

/** Hardware-scroll wrap amount subtracted from the address once it overruns
 *  0x7FFF, selected by the IC32 C0/C1 outputs (see the BeebWiki address
 *  translation table). */
export function wrapSubtract(c0: number, c1: number): number {
  if (c1 && c0) return 0x2800;   // modes 4,5
  if (c1) return 0x5000;         // modes 0,1,2
  if (c0) return 0x2000;         // mode 6
  return 0x4000;                 // mode 3
}

/** Teletext address translation from the 6845 MA (bit 11 selects the 0x7C00
 *  block; bit 10 is ignored). */
function teletextAddr(ma: number): number {
  return (0x3C00 | ((ma & 0x0800) << 3) | (ma & 0x03FF)) & 0x7FFF;
}

export class BbcVideo {
  readonly width = W;
  /** Current frame-buffer layout; see `setLayout`. */
  layout: BbcLayout = BBC_LAYOUT_1X;
  /** Backing store sized for the tallest layout; `pixels` is the live view. */
  private readonly store = new Uint8Array(W * BBC_LAYOUT_HIRES.screenHeight * 4);
  pixels: Uint8Array = this.store.subarray(0, W * this.layout.screenHeight * 4);
  private pixels32 = new Uint32Array(this.store.buffer, 0, W * this.layout.screenHeight);

  get height(): number { return this.layout.screenHeight; }

  /** Switch the buffer between the 1x and hi-res layouts (clears the frame). */
  setLayout(layout: BbcLayout): void {
    if (layout === this.layout) return;
    this.layout = layout;
    this.pixels = this.store.subarray(0, W * layout.screenHeight * 4);
    this.pixels32 = new Uint32Array(this.store.buffer, 0, W * layout.screenHeight);
    this.pixels32.fill(0xFF000000);
  }

  private readonly saa = new Saa5050();
  private readonly cells: Saa5050Cell[] = createSaa5050Cells(40);
  private readonly rowBytes = new Uint8Array(40);
  /** Draw Mode 7 as the plain dots, one line per glyph row, leaving the
   *  character rounding and smoothing to the SAA5050 upscaler. */
  rawTeletext = false;
  /** Palette family from the display setting. */
  paletteMode: 'pal' | 'measured' = 'pal';

  private pal(): Uint32Array {
    return this.paletteMode === 'measured' ? MEASURED_PALETTE32 : PAL_PALETTE32;
  }

  /** The active 8-entry physical palette (packed ABGR) for the current mode.
   *  Exposed so Mode 7 text OCR can blank matched cells to their paper colour. */
  activePalette(): Uint32Array {
    return this.pal();
  }

  reset(): void {
    this.saa.reset();
    this.pixels32.fill(BLACK);
    this.endLine();
  }

  /** Derive the BBC screen mode from the Video ULA control register + CRTC. */
  screenMode(m: BbcMachine): number {
    const ctrl = m.videoUlaControl;
    if (ctrl & 0x02) return 7;                 // teletext select
    const cpl = (ctrl >> 2) & 3;               // 0=10, 1=20, 2=40, 3=80 cols
    const highClock = (ctrl & 0x10) !== 0;     // 1 = modes 0-3
    if (highClock) {
      if (cpl === 3) return 0;
      if (cpl === 2) return 1;
      if (cpl === 1) return 2;
      return 0;
    }
    if (cpl === 3) return 3;
    if (cpl === 2) return m.crtc.regs[6] >= 30 ? 4 : 6;
    if (cpl === 1) return 5;
    return 4;
  }

  render(m: BbcMachine): void {
    const mode = this.screenMode(m);
    this.pixels32.fill(BLACK);
    if (mode === 7) this.renderTeletext(m);
    else this.renderBitmap(m, mode);
  }

  /** Fetch the character row at `maRow` and run it through the SAA5050. */
  private teletextCells(m: BbcMachine, maRow: number): void {
    for (let c = 0; c < TELETEXT_COLS; c++) {
      this.rowBytes[c] = m.memory.ram[teletextAddr(maRow + c)];
    }
    this.saa.renderRow(this.rowBytes, TELETEXT_COLS, this.cells);
  }

  /** Draw scanline `k` (0-9) of teletext cells [from, to) at buffer row `y`:
   *  one blended row, or in the hi-res layout the chip's two rounded rows. */
  private teletextCellLine(k: number, y: number, from: number, to: number): void {
    const { hires, screenHeight: H } = this.layout;
    const xBase = BBC_BORDER_LEFT + ((BBC_ACTIVE_WIDTH - TELETEXT_COLS * CELL_W) >> 1);
    const pal = this.pal();
    for (let c = from; c < to; c++) {
      const cell = this.cells[c];
      const fgCol = pal[cell.fg & 7];
      const bgCol = pal[cell.bg & 7];
      // 50/50 mix of the two (per 8-bit channel, alpha kept opaque).
      const midCol = ((((fgCol & 0xFEFEFE) >>> 1) + ((bgCol & 0xFEFEFE) >>> 1)) | 0xFF000000) >>> 0;
      const x0 = xBase + c * CELL_W;
      if (hires) {
        // The chip's own rounded lines: ink or paper, no blending.
        for (let h = 0; h < 2; h++) {
          const py = y + h;
          if (py < 0 || py >= H) continue;
          const out = py * W;
          const row = cell.pixels[k * 2 + h];
          for (let x = 0; x < CELL_W; x++) {
            const px = x0 + x;
            if (px < 0 || px >= W) continue;
            this.pixels32[out + px] = ((row >> x) & 1) ? fgCol : bgCol;
          }
        }
        continue;
      }
      if (y < 0 || y >= H) continue;
      const out = y * W;
      const even = cell.pixels[k * 2];
      // Unrounded, both half-lines are the same dot row: draw it as is.
      const odd = this.rawTeletext ? even : cell.pixels[k * 2 + 1];
      for (let x = 0; x < CELL_W; x++) {
        const px = x0 + x;
        if (px < 0 || px >= W) continue;
        // 12-bit rows; bit 0 = leftmost. Lit in both half-lines = ink,
        // in one = the half-tone that carries the character rounding.
        const lit = ((even >> x) & 1) + ((odd >> x) & 1);
        this.pixels32[out + px] = lit === 2 ? fgCol : lit === 1 ? midCol : bgCol;
      }
    }
  }

  private renderTeletext(m: BbcMachine): void {
    const rows = 25;
    const { vscale, borderTop, activeHeight, screenHeight: H } = this.layout;
    // The SAA5050 cell is 12×20 (rounded), shown as 10 scanlines, each a
    // half-line pair, or at 2x and up as the full 20 lines.
    const ch = 10 * vscale;
    const yBase = borderTop + ((activeHeight - rows * ch) >> 1);
    const start = m.crtc.displayStart;
    // The 6845 advances its row address by R1 (horizontal displayed), which is
    // 40 in Mode 7 — not R0+1 (the 64-character horizontal total).
    const stride = m.crtc.regs[1] || TELETEXT_COLS;

    // The SAA5050's colour/graphics state carries across rows within a field
    // but is re-initialised at the start of each field (frame).
    this.saa.reset();
    this.saa.rounding = !this.rawTeletext;

    for (let r = 0; r < rows; r++) {
      this.teletextCells(m, start + r * stride);
      const y0 = yBase + r * ch;
      if (y0 + ch <= 0 || y0 >= H) continue;
      for (let k = 0; k < 10; k++) this.teletextCellLine(k, y0 + k * vscale, 0, TELETEXT_COLS);
    }
  }

  /** Draw characters [from, to) of one bitmap scanline — the character row at
   *  `maRow`, raster `ra` — at buffer row `y` (and the row below it in the
   *  hi-res layout, where each scanline is drawn twice). */
  private bitmapRow(
    m: BbcMachine, mode: number, y: number, maRow: number, ra: number, from: number, to: number,
  ): void {
    const info = bitmapMode(mode);
    const scale = BBC_ACTIVE_WIDTH / info.width;
    const n = 8 / info.bpp;               // pixels per byte
    // R1 MA units per displayed line, and no wider than the mode.
    const last = Math.min(to, m.crtc.regs[1], info.width / n);
    if (last <= from) return;
    const sub = wrapSubtract(m.ic32.c0, m.ic32.c1);
    const pal = this.pal();
    // The ULA's flash bit selects the second colour of every flashing colour
    // (the OS toggles it on its flash timer).
    const flash = (m.videoUlaControl & 0x01) !== 0;
    const out = y * W;
    // Hi-res address translation: each 6845 MA unit is one byte-wide column of
    // eight scanlines, so the byte for a cell is (MA << 3) | RA, wrapped if the
    // ROM address overruns the top of RAM.
    for (let p = from; p < last; p++) {
      const ma = maRow + p;
      let addr = ((ma & 0x1FFF) << 3) | ra;
      if (ma & 0x1000) addr = (addr - sub) & 0x7FFF;
      const byte = m.memory.ram[addr & 0x7FFF];
      // The ULA interleaves the pixel bits across the byte rather than
      // packing them contiguously: the top `bpp` bits of the byte are the
      // most-significant bits of the `n` pixels, then the next group, etc.
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let j = 0; j < info.bpp; j++) {
          v = (v << 1) | ((byte >> ((info.bpp - 1 - j) * n + (n - 1 - i))) & 1);
        }
        this.putPixels(out, p * n + i, m.palette[v], scale, flash, pal);
      }
    }
    if (this.layout.vscale === 2) {
      const x0 = BBC_BORDER_LEFT + Math.round(from * n * scale);
      const x1 = BBC_BORDER_LEFT + Math.round(last * n * scale);
      this.pixels32.copyWithin(out + W + x0, out + x0, out + x1);
    }
  }

  private renderBitmap(m: BbcMachine, mode: number): void {
    const r1 = m.crtc.regs[1];            // MA units per displayed line
    const r6 = m.crtc.regs[6];            // character rows displayed
    // Scanlines per character row: 8, or 10 in the gapped text modes 3 and 6,
    // whose last two lines (RA bit 3 set) the ULA blanks.
    const lpr = (m.crtc.regs[9] & 0x1F) + 1;
    const { vscale, borderTop, activeHeight, screenHeight: H } = this.layout;
    // At 2x and up each scanline is drawn twice.
    const yOff = borderTop + ((activeHeight - r6 * lpr * vscale) >> 1);
    const start = m.crtc.displayStart;
    for (let row = 0; row < r6; row++) {
      const maRow = start + row * r1;
      for (let ra = 0; ra < Math.min(lpr, 8); ra++) {
        const y = yOff + (row * lpr + ra) * vscale;
        if (y < 0 || y + vscale > H) continue;
        this.bitmapRow(m, mode, y, maRow, ra, 0, r1);
      }
    }
  }

  // ── Drawing as the beam goes (Mid and High accuracy) ─────────────────────

  /** Buffer row of frame line 0 in the frame in progress. */
  private lineTop = 0;
  /** The scanline in progress has been blanked and started. */
  private lineStarted = false;
  /** Characters of the scanline in progress already drawn. */
  private drawn = 0;
  /** The row address the teletext cells were worked out for, or -1. */
  private cellsRow = -1;

  /** Start a frame drawn as the beam goes. It sits where `render` would put
   *  it (the displayed rows centred in the active area, frame line 0 being the
   *  first displayed line) and the rows above it are blanked; every scanline
   *  blanks its own row as it starts, so below the beam a paused frame still
   *  shows the one before, as a CRT would. */
  beginFrame(m: BbcMachine): void {
    const { vscale, borderTop, activeHeight, screenHeight: H } = this.layout;
    const r9 = m.crtc.regs[9] & 0x1F;
    const rowLines = m.crtc.interlaceVideo ? (r9 >> 1) + 1 : r9 + 1;
    this.lineTop = borderTop + ((activeHeight - m.crtc.regs[6] * rowLines * vscale) >> 1);
    if (this.lineTop > 0) this.pixels32.fill(BLACK, 0, Math.min(this.lineTop, H) * W);
    this.saa.reset();
    this.saa.rounding = !this.rawTeletext;
    this.cellsRow = -1;
    this.endLine();
  }

  /** Draw the scanline in progress (frame line `line`) from where it was left
   *  up to character `to` (exclusive; Infinity for the rest of the line), with
   *  the CRTC, ULA and memory as they are now. */
  drawLine(m: BbcMachine, line: number, to: number): void {
    if (to <= this.drawn) return;
    const { vscale, screenHeight: H } = this.layout;
    const y = this.lineTop + line * vscale;
    const from = this.drawn;
    this.drawn = to;
    if (y < 0 || y + vscale > H) return;
    if (!this.lineStarted) {
      this.lineStarted = true;
      this.pixels32.fill(BLACK, y * W, (y + vscale) * W);
    }
    const crtc = m.crtc;
    if (!crtc.inVerticalDisplay) return;
    const mode = this.screenMode(m);
    const ra = crtc.rasterAddress;
    if (mode === 7) {
      // A character row's cells are worked out when the beam first reaches
      // it; a write to the row after that shows from the next row down.
      const maRow = crtc.rowAddress;
      if (this.cellsRow !== maRow) {
        this.teletextCells(m, maRow);
        this.cellsRow = maRow;
      }
      const k = ra >> 1;
      if (k < 10) this.teletextCellLine(k, y, from, Math.min(to, TELETEXT_COLS));
      return;
    }
    // The gapped text modes' last two rasters (RA bit 3) are blank.
    if (ra < 8) this.bitmapRow(m, mode, y, crtc.rowAddress, ra, from, to);
  }

  /** The scanline in progress is done; the next `drawLine` starts a new one. */
  endLine(): void {
    this.lineStarted = false;
    this.drawn = 0;
  }

  private putPixels(
    out: number, x: number, phys: number, scale: number, flash: boolean, pal: Uint32Array,
  ): void {
    const colour = flash && phys >= 8 ? (phys & 7) ^ 7 : phys & 7;  // flashing inverts
    const c = pal[colour];
    const px = BBC_BORDER_LEFT + Math.round(x * scale);
    for (let i = 0; i < scale; i++) this.pixels32[out + px + i] = c;
  }
}
