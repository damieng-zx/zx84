/**
 * Amstrad Gate Array (40007/40008/40010).
 *
 * Responsibilities:
 *   - Pen/ink colour registers (17 pens × the 27-colour hardware palette).
 *   - Screen mode (0/1/2), latched and applied at the next HSYNC.
 *   - ROM enable + RAM banking (delegated to CpcMemory via callbacks).
 *   - The raster interrupt: counts HSYNCs and raises the Z80 INT line every
 *     52 lines, with the VSYNC re-sync and acknowledge rules.
 *   - Turning display bytes into pixels: per scanline it fetches the CRTC's
 *     display bytes and decodes mode 0/1/2 through the pens into the RGBA frame
 *     buffer, surrounded by the border pen.
 */

import {
  CPC_PALETTE, CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT, CPC_BORDER_LEFT,
} from '@/cpc/constants.ts';
import type { CrtcLine } from '@/cores/crtc-6845.ts';

const FN_PEN = 0x00;
const FN_COLOUR = 0x40;
const FN_RMR = 0x80;
const FN_RAM = 0xC0;

const BORDER_PEN = 16;

export class GateArray {
  private selectedPen = 0;
  /** Hardware colour (0–31) for each pen (0–15) and the border (16). */
  readonly pens = new Uint8Array(17);

  mode = 1;
  private pendingMode = 1;

  onLowerRom: (enabled: boolean) => void = () => {};
  onUpperRom: (enabled: boolean) => void = () => {};
  onRamConfig: (val: number) => void = () => {};

  // ── Raster interrupt ─────────────────────────────────────────────────
  private rasterCount = 0;
  interruptRequested = false;

  write(val: number): void {
    switch (val & 0xC0) {
      case FN_PEN:
        this.selectedPen = (val & 0x10) ? BORDER_PEN : (val & 0x0F);
        break;
      case FN_COLOUR:
        this.pens[this.selectedPen] = val & 0x1F;
        break;
      case FN_RMR:
        this.pendingMode = val & 0x03;
        this.onLowerRom((val & 0x04) === 0);
        this.onUpperRom((val & 0x08) === 0);
        if (val & 0x10) {
          this.rasterCount = 0;
          this.interruptRequested = false;
        }
        break;
      case FN_RAM:
        this.onRamConfig(val);
        break;
    }
  }

  onHSync(): void {
    this.mode = this.pendingMode;
    this.rasterCount++;
    if (this.rasterCount === 52) {
      this.rasterCount = 0;
      this.interruptRequested = true;
    }
  }

  onVSyncResync(): void {
    if (this.rasterCount >= 32) this.interruptRequested = true;
    this.rasterCount = 0;
  }

  acknowledgeInterrupt(): void {
    this.interruptRequested = false;
    this.rasterCount &= 0x1F;
  }

  reset(): void {
    this.selectedPen = 0;
    this.pens.fill(0);
    this.mode = 1;
    this.pendingMode = 1;
    this.rasterCount = 0;
    this.interruptRequested = false;
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  /** Fill the whole frame buffer with the current border colour (top/bottom
   *  border and any rows a short frame never reaches). */
  beginFrame(px: Uint32Array): void {
    px.fill(CPC_PALETTE[this.pens[BORDER_PEN] & 0x1F]);
  }

  /**
   * Render one scanline. `bufferY` is the output row; `line` is the CRTC state
   * for the scanline; `readVideo(addr)` reads base-64K display RAM.
   */
  renderScanline(px: Uint32Array, bufferY: number, line: CrtcLine,
                 readVideo: (addr: number) => number): void {
    if (bufferY < 0 || bufferY >= CPC_SCREEN_HEIGHT) return;
    const rowStart = bufferY * CPC_SCREEN_WIDTH;
    const border = CPC_PALETTE[this.pens[BORDER_PEN] & 0x1F];
    px.fill(border, rowStart, rowStart + CPC_SCREEN_WIDTH);
    if (!line.vDisplay) return;

    const mode = this.mode;
    let x = CPC_BORDER_LEFT;
    for (let c = 0; c < line.hDisplayed; c++) {
      const ma = (line.maRow + c) & 0x3FFF;
      const addr = (((ma & 0x3000) << 2) | ((line.ra & 7) << 11) | ((ma & 0x3FF) << 1)) & 0xFFFF;
      const b0 = readVideo(addr);
      const b1 = readVideo((addr + 1) & 0xFFFF);
      x = this.plotChar(px, rowStart, x, b0, b1, mode);
      if (x >= CPC_SCREEN_WIDTH) break;
    }
  }

  /** Plot one character (two display bytes = 16 pixel-clocks) and return the
   *  next x. Mode determines how the 16 clocks split into logical pixels. */
  private plotChar(px: Uint32Array, rowStart: number, x: number,
                   b0: number, b1: number, mode: number): number {
    const pal = CPC_PALETTE;
    const pens = this.pens;
    const put = (n: number, pen: number): void => {
      const px0 = x;
      const rgba = pal[pens[pen & 0x0F] & 0x1F];
      for (let i = 0; i < n; i++) {
        const xi = px0 + i;
        if (xi >= 0 && xi < CPC_SCREEN_WIDTH) px[rowStart + xi] = rgba;
      }
      x += n;
    };

    if (mode === 0) {
      // 2 pixels/byte, 4 clocks each.
      for (const b of [b0, b1]) {
        put(4, ((b & 0x80) >> 7) | ((b & 0x08) >> 2) | ((b & 0x20) >> 3) | ((b & 0x02) << 2));
        put(4, ((b & 0x40) >> 6) | ((b & 0x04) >> 1) | ((b & 0x10) >> 2) | ((b & 0x01) << 3));
      }
    } else if (mode === 1) {
      // 4 pixels/byte, 2 clocks each.
      for (const b of [b0, b1]) {
        put(2, ((b & 0x80) >> 7) | ((b & 0x08) >> 2));
        put(2, ((b & 0x40) >> 6) | ((b & 0x04) >> 1));
        put(2, ((b & 0x20) >> 5) | ((b & 0x02) >> 0));
        put(2, ((b & 0x10) >> 4) | ((b & 0x01) << 1));
      }
    } else {
      // Mode 2 (and 3, treated as 2): 8 pixels/byte, 1 clock each.
      for (const b of [b0, b1]) {
        for (let bit = 7; bit >= 0; bit--) put(1, (b >> bit) & 1);
      }
    }
    return x;
  }
}
