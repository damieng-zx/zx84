/**
 * BBC Micro video output.
 *
 * Mode 7 is rendered by the SAA5050 teletext generator (6×10 cells, doubled to
 * 12 pixels wide in the 640×256 buffer). Modes 0-6 are rendered from the 6845's
 * MA through the video ULA's bit-depth/palette mapping. Both read display RAM
 * directly; the machine owns the frame timing.
 */

import { Saa5050, createSaa5050Cells, type Saa5050Cell } from '@/cores/saa5050.ts';
import { BBC_SCREEN_HEIGHT, BBC_SCREEN_WIDTH } from './constants.ts';
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

interface BitmapMode {
  readonly bpp: 1 | 2 | 4;
  /** Active pixel width (640, 320 or 160). */
  readonly width: number;
  /** Bytes fetched per scanline. */
  readonly lineBytes: number;
  /** 200-line text modes (3 and 6) sit centred in the 256-line buffer. */
  readonly lines: 200 | 256;
}

function bitmapMode(mode: number): BitmapMode {
  switch (mode) {
    case 0: return { bpp: 1, width: 640, lineBytes: 80, lines: 256 };
    case 1: return { bpp: 2, width: 320, lineBytes: 80, lines: 256 };
    case 2: return { bpp: 4, width: 160, lineBytes: 80, lines: 256 };
    case 3: return { bpp: 1, width: 640, lineBytes: 80, lines: 200 };
    case 4: return { bpp: 1, width: 320, lineBytes: 40, lines: 256 };
    case 5: return { bpp: 2, width: 160, lineBytes: 40, lines: 256 };
    default: return { bpp: 1, width: 320, lineBytes: 40, lines: 200 };
  }
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

  reset(): void {
    this.saa.reset();
    this.pixels32.fill(0xFF000000);
    this.flashPhase = false;
  }

  /** Derive the BBC screen mode from the Video ULA control register + CRTC. */
  private mode(m: BbcMachine): number {
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
    const mode = this.mode(m);
    const flash = (m.videoUlaControl & 0x01) !== 0 && this.flashPhase;
    this.pixels32.fill(0xFF000000);
    if (mode === 7) this.renderTeletext(m, flash);
    else this.renderBitmap(m, mode, flash);
  }

  private renderTeletext(m: BbcMachine, flash: boolean): void {
    const cols = 40;
    const rows = 25;
    const cw = 12;       // SAA5050 cell, already doubled to 12×20 by the core
    const ch = 20;
    const xBase = (W - cols * cw) >> 1;
    const yBase = (H - rows * ch) >> 1;
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
        const x0 = xBase + c * cw;
        for (let y = 0; y < ch; y++) {
          const py = y0 + y;
          if (py < 0 || py >= H) continue;
          const row = cell.pixels[y];
          const out = py * W;
          for (let x = 0; x < cw; x++) {
            const px = x0 + x;
            if (px < 0 || px >= W) continue;
            const bit = (row >> x) & 1;   // 12-bit row; bit 0 = leftmost
            this.pixels32[out + px] = bit ? fgCol : bgCol;
          }
        }
      }
    }
  }

  private renderBitmap(m: BbcMachine, mode: number, flash: boolean): void {
    const info = bitmapMode(mode);
    const scale = W / info.width;
    const yOff = (H - info.lines) >> 1;
    const r9 = m.crtc.regs[9];
    const r6 = Math.min(m.crtc.regs[6], Math.floor(info.lines / (r9 + 1)));
    const start = m.crtc.displayStart;
    const rowStride = (r9 + 1) * info.lineBytes;

    for (let row = 0; row < r6; row++) {
      for (let ra = 0; ra <= r9; ra++) {
        const y = yOff + row * (r9 + 1) + ra;
        if (y < 0 || y >= H) continue;
        const lineAddr = (start + row * rowStride + ra * info.lineBytes) & 0x7FFF;
        let x = 0;
        const out = y * W;
        for (let bi = 0; bi < info.lineBytes && x < info.width; bi++) {
          const byte = m.memory.ram[(lineAddr + bi) & 0x7FFF];
          if (info.bpp === 1) {
            for (let k = 7; k >= 0; k--) {
              this.putPixels(out, x++, m.palette[(byte >> k) & 1], scale, flash);
            }
          } else if (info.bpp === 2) {
            for (let k = 6; k >= 0; k -= 2) {
              this.putPixels(out, x++, m.palette[(byte >> k) & 3], scale, flash);
            }
          } else {
            for (let k = 4; k >= 0; k -= 4) {
              this.putPixels(out, x++, m.palette[(byte >> k) & 0x0F], scale, flash);
            }
          }
        }
      }
    }
  }

  private putPixels(out: number, x: number, phys: number, scale: number, flash: boolean): void {
    const colour = flash && phys >= 8 ? (phys & 7) ^ 7 : phys & 7;  // flashing inverts
    const c = this.pal()[colour];
    const px = Math.round(x * scale);
    for (let i = 0; i < scale; i++) this.pixels32[out + px + i] = c;
  }
}
