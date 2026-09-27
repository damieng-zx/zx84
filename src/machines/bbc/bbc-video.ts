/**
 * BBC Micro video output.
 *
 * Mode 7 is rendered by the SAA5050 teletext generator: its rounded 12×20
 * cells are two interlaced fields of 10 lines, so each buffer line blends the
 * pair (50% where only one half-line is lit), as the eye does on a TV. Modes
 * 0-6 are rendered from the 6845's
 * MA through the video ULA's bit-depth/palette mapping. Both read display RAM
 * directly; the machine owns the frame timing.
 */

import { Saa5050, createSaa5050Cells, type Saa5050Cell } from '@/cores/saa5050.ts';
import {
  BBC_ACTIVE_HEIGHT, BBC_ACTIVE_WIDTH, BBC_BORDER_LEFT, BBC_BORDER_TOP,
  BBC_SCREEN_HEIGHT, BBC_SCREEN_WIDTH,
} from './constants.ts';
import type { BbcMachine } from './bbc-machine.ts';

const W = BBC_SCREEN_WIDTH;
const H = BBC_SCREEN_HEIGHT;

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
  readonly height = H;
  readonly pixels = new Uint8Array(W * H * 4);
  private readonly pixels32 = new Uint32Array(this.pixels.buffer);

  private readonly saa = new Saa5050();
  private readonly cells: Saa5050Cell[] = createSaa5050Cells(40);
  private readonly rowBytes = new Uint8Array(40);
  /** Toogled every ~32 frames while the ULA flash bit is set. */
  flashPhase = false;
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
    this.pixels32.fill(0xFF000000);
    this.flashPhase = false;
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
    const flash = (m.videoUlaControl & 0x01) !== 0 && this.flashPhase;
    this.pixels32.fill(0xFF000000);
    if (mode === 7) this.renderTeletext(m, flash);
    else this.renderBitmap(m, mode, flash);
  }

  private renderTeletext(m: BbcMachine, flash: boolean): void {
    const cols = 40;
    const rows = 25;
    const cw = 12;       // SAA5050 cell: 12×20 from the core (rounded) ...
    const ch = 10;       // ... shown as 10 scanlines, each a half-line pair
    const xBase = BBC_BORDER_LEFT + ((BBC_ACTIVE_WIDTH - cols * cw) >> 1);
    const yBase = BBC_BORDER_TOP + ((BBC_ACTIVE_HEIGHT - rows * ch) >> 1);
    const start = m.crtc.displayStart;
    // The 6845 advances its row address by R1 (horizontal displayed), which is
    // 40 in Mode 7 — not R0+1 (the 64-character horizontal total).
    const stride = m.crtc.regs[1] || cols;
    const pal = this.pal();

    // The SAA5050's colour/graphics state carries across rows within a field
    // but is re-initialised at the start of each field (frame).
    this.saa.reset();

    for (let r = 0; r < rows; r++) {
      const maRow = start + r * stride;
      for (let c = 0; c < cols; c++) {
        this.rowBytes[c] = m.memory.ram[teletextAddr(maRow + c)];
      }
      this.saa.renderRow(this.rowBytes, cols, this.cells);
      const y0 = yBase + r * ch;
      if (y0 + ch <= 0 || y0 >= H) continue;
      for (let c = 0; c < cols; c++) {
        const cell = this.cells[c];
        const fg = flash ? cell.bg : cell.fg;
        const bg = flash ? cell.fg : cell.bg;
        const fgCol = pal[fg & 7];
        const bgCol = pal[bg & 7];
        // 50/50 mix of the two (per 8-bit channel, alpha kept opaque).
        const midCol = ((((fgCol & 0xFEFEFE) >>> 1) + ((bgCol & 0xFEFEFE) >>> 1)) | 0xFF000000) >>> 0;
        const x0 = xBase + c * cw;
        for (let y = 0; y < ch; y++) {
          const py = y0 + y;
          if (py < 0 || py >= H) continue;
          const even = cell.pixels[y * 2];
          const odd = cell.pixels[y * 2 + 1];
          const out = py * W;
          for (let x = 0; x < cw; x++) {
            const px = x0 + x;
            if (px < 0 || px >= W) continue;
            // 12-bit rows; bit 0 = leftmost. Lit in both half-lines = ink,
            // in one = the half-tone that carries the character rounding.
            const lit = ((even >> x) & 1) + ((odd >> x) & 1);
            this.pixels32[out + px] = lit === 2 ? fgCol : lit === 1 ? midCol : bgCol;
          }
        }
      }
    }
  }

  private renderBitmap(m: BbcMachine, mode: number, flash: boolean): void {
    const info = bitmapMode(mode);
    const scale = BBC_ACTIVE_WIDTH / info.width;
    const r1 = m.crtc.regs[1];            // MA units per displayed line
    const r6 = m.crtc.regs[6];            // character rows displayed
    // Scanlines per character row: 8, or 10 in the gapped text modes 3 and 6,
    // whose last two lines (RA bit 3 set) the ULA blanks.
    const lpr = (m.crtc.regs[9] & 0x1F) + 1;
    const yOff = BBC_BORDER_TOP + ((BBC_ACTIVE_HEIGHT - r6 * lpr) >> 1);
    const start = m.crtc.displayStart;
    const sub = wrapSubtract(m.ic32.c0, m.ic32.c1);
    const pal = this.pal();
    const n = 8 / info.bpp;               // pixels per byte

    // Hi-res address translation: each 6845 MA unit is one byte-wide column of
    // eight scanlines, so the byte for a cell is (MA << 3) | RA, wrapped if the
    // ROM address overruns the top of RAM.
    for (let row = 0; row < r6; row++) {
      const maRow = start + row * r1;
      for (let ra = 0; ra < Math.min(lpr, 8); ra++) {
        const y = yOff + row * lpr + ra;
        if (y < 0 || y >= H) continue;
        const out = y * W;
        let x = 0;
        for (let p = 0; p < r1 && x < info.width; p++) {
          const ma = maRow + p;
          let addr = ((ma & 0x1FFF) << 3) | ra;
          if (ma & 0x1000) addr = (addr - sub) & 0x7FFF;
          const byte = m.memory.ram[addr & 0x7FFF];
          // The ULA interleaves the pixel bits across the byte rather than
          // packing them contiguously: the top `bpp` bits of the byte are the
          // most-significant bits of the `n` pixels, then the next group, etc.
          for (let i = 0; i < n && x < info.width; i++) {
            let v = 0;
            for (let j = 0; j < info.bpp; j++) {
              v = (v << 1) | ((byte >> ((info.bpp - 1 - j) * n + (n - 1 - i))) & 1);
            }
            this.putPixels(out, x++, m.palette[v], scale, flash, pal);
          }
        }
      }
    }
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
