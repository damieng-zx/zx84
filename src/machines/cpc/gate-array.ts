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
  CPC_PALETTE, CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT,
} from '@/machines/cpc/constants.ts';
import type { CrtcLine } from '@/cores/crtc-6845.ts';

const FN_PEN = 0x00;
const FN_COLOUR = 0x40;
const FN_RMR = 0x80;
const FN_RAM = 0xC0;
export { FN_PEN, FN_COLOUR, FN_RMR, FN_RAM };

const BORDER_PEN = 16;

/** Buffer pixels per CRTC character. The standard 40-char display is 640 px
 *  wide (CPC_SCREEN_WIDTH − 2·CPC_BORDER_LEFT), i.e. 16 px per character. */
const CPC_CHAR_PX = 16;

export class GateArray {
  protected selectedPen = 0;
  /** Hardware colour (0–31) for each pen (0–15) and the border (16). */
  readonly pens = new Uint8Array(17);

  mode = 1;
  protected pendingMode = 1;

  /** Active colour map (ABGR, indexed by hardware value 0–31). Swapped by the
   *  display settings; defaults to the measured Gate Array palette. */
  palette: Uint32Array = CPC_PALETTE;

  onLowerRom: (enabled: boolean) => void = () => {};
  onUpperRom: (enabled: boolean) => void = () => {};
  onRamConfig: (val: number) => void = () => {};

  // ── Raster interrupt ─────────────────────────────────────────────────
  /** Gate-array HSync interrupt counter (0–51). Public so ASIC interrupt tests
   *  can assert it is not perturbed when a PRI coincides with the 52-wrap; only
   *  the GA/ASIC mutate it. */
  rasterCount = 0;
  interruptRequested = false;

  write(val: number): void {
    switch (val & 0xC0) {
      case FN_PEN:
        this.selectedPen = (val & 0x10) ? BORDER_PEN : (val & 0x0F);
        break;
      case FN_COLOUR:
        this.pens[this.selectedPen] = val & 0x1F;
        this.onPenColourChanged(this.selectedPen, val & 0x1F);
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

  // ── Snapshot state (.SNA) ─────────────────────────────────────────────

  /** Currently selected pen (0–15, or 16 for the border) — for snapshot save. */
  get selectedPenIndex(): number { return this.selectedPen; }

  /** Restore pen selection, screen mode and the 17 pen colours from a snapshot.
   *  `pendingMode` is set to `mode` so no stale mid-frame mode change lingers. */
  restoreState(selectedPen: number, mode: number, pens: ArrayLike<number>): void {
    this.selectedPen = selectedPen & 0x1F;
    this.mode = mode & 0x03;
    this.pendingMode = this.mode;
    for (let i = 0; i < 17; i++) this.pens[i] = (pens[i] ?? 0) & 0x1F;
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  /** Resolved RGBA for the 16 drawing pens, rebuilt once per scanline. Kept as
   *  a field (not re-allocated) so the per-pixel plot is a plain array index.
   *  On the Plus, `Asic` overrides `refreshPenLut`/`borderColor`/`renderStartX`
   *  to feed the 12-bit ASIC palette and apply scroll/border extensions. */
  protected readonly penLut = new Uint32Array(16);

  /** Resolve the current border colour to an RGBA word. */
  protected borderColor(): number {
    return this.palette[this.pens[BORDER_PEN] & 0x1F];
  }

  /** Horizontal pixel offset where the first display character starts.
   *
   *  The active area is centred in the framebuffer by its displayed width, so
   *  the standard 40-char display lands at CPC_BORDER_LEFT (64) exactly — same
   *  as a fixed anchor — while an overscan display (hDisplayed > 40) shifts
   *  left to stay centred on the monitor. A real CPC centres the display on the
   *  tube regardless of width (games widen R1 and pull the HSYNC position in to
   *  recentre); a fixed left anchor instead lets a wide display overflow the
   *  right edge (e.g. the Crazy Cars II title, hDisplayed ≈ 46, clipped its
   *  right end). The ASIC overrides this when unlocked to add hscroll +
   *  extendBorder on top of the centred base. */
  protected renderStartX(hDisplayed: number): number {
    return (CPC_SCREEN_WIDTH - hDisplayed * CPC_CHAR_PX) >> 1;
  }

  /** (Re)fill `penLut` with the RGBA of drawing pens 0–15. */
  protected refreshPenLut(): void {
    for (let p = 0; p < 16; p++) this.penLut[p] = this.palette[this.pens[p] & 0x1F];
  }

  /** Hook for the Plus ASIC's vertical soft scroll: given the byte address
   *  computed from MA/RA above, return the address actually fetched. No-op
   *  on the plain gate array. */
  protected videoAddress(addr: number): number {
    return addr;
  }

  /** Hook for the Plus ASIC: called whenever a classic FN_COLOUR command sets
   *  a pen (0-15) or the border (16) to a hardware colour code. Real hardware
   *  translates these &7Fxx writes into the same 12-bit ASIC palette RAM that
   *  &6400 MMIO writes, so old-style colour code still works once a game
   *  unlocks the extended features without reprogramming colour via &6400.
   *  No-op on the plain gate array. */
  protected onPenColourChanged(_pen: number, _hwColour: number): void {}

  /** Fill the whole frame buffer with the current border colour (top/bottom
   *  border and any rows a short frame never reaches). */
  beginFrame(px: Uint32Array): void {
    px.fill(this.borderColor());
  }

  /**
   * Render one scanline. `bufferY` is the output row; `line` is the CRTC state
   * for the scanline; `readVideo(addr)` reads base-64K display RAM.
   */
  renderScanline(px: Uint32Array, bufferY: number, line: CrtcLine,
                 readVideo: (addr: number) => number): void {
    if (bufferY < 0 || bufferY >= CPC_SCREEN_HEIGHT) return;
    const rowStart = bufferY * CPC_SCREEN_WIDTH;
    px.fill(this.borderColor(), rowStart, rowStart + CPC_SCREEN_WIDTH);
    if (!line.vDisplay) return;

    // Snapshot the pen colours for this scanline (mid-frame palette changes
    // take effect per line, matching the per-scanline render loop).
    this.refreshPenLut();
    const mode = this.mode;
    let x = this.renderStartX(line.hDisplayed);
    for (let c = 0; c < line.hDisplayed; c++) {
      const ma = (line.maRow + c) & 0x3FFF;
      const addr = this.videoAddress(
        (((ma & 0x3000) << 2) | ((line.ra & 7) << 11) | ((ma & 0x3FF) << 1)) & 0xFFFF);
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
    const lut = this.penLut;
    const put = (n: number, pen: number): void => {
      const px0 = x;
      const rgba = lut[pen & 0x0F];
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
