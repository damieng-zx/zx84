/**
 * Motorola 6845 CRTC (and the UM6845R/HD6845S variants used in the CPC).
 *
 * Sequences the raster: characters per line (R0), rasters per character row
 * (R9), character rows per frame (R4), plus the display window (R1/R6), the
 * sync positions (R2/R7), and the screen base (R12/R13). The Gate Array reads
 * display bytes at the address this produces and turns them into pixels.
 *
 * Stepping is per-scanline: `beginFrame()` then, for each scanline,
 * `currentLine()` to read the row state and `advanceLine()` to move on. This is
 * fine-grained enough for per-scanline raster effects (mid-frame mode, palette,
 * scroll, and split screens) while staying simple; the registers are sampled at
 * each line boundary so changes between lines take effect.
 */

export const R_HORIZ_TOTAL = 0;
export const R_HORIZ_DISPLAYED = 1;
export const R_HSYNC_POS = 2;
export const R_SYNC_WIDTHS = 3;
export const R_VERT_TOTAL = 4;
export const R_VERT_ADJUST = 5;
export const R_VERT_DISPLAYED = 6;
export const R_VSYNC_POS = 7;
export const R_MAX_RASTER = 9;
export const R_DISPLAY_START_H = 12;
export const R_DISPLAY_START_L = 13;

/** State of the scanline about to be rendered. */
export interface CrtcLine {
  /** Display memory address at the start of this scanline's character row. */
  maRow: number;
  /** Raster line within the character row (0–R9). */
  ra: number;
  /** Number of characters displayed on this line (R1). */
  hDisplayed: number;
  /** Whether this line is in the vertical display region (VCC < R6). */
  vDisplay: boolean;
}

export class Crtc6845 {
  readonly regs = new Uint8Array(18);
  private selected = 0;

  constructor(private readonly type: 0 | 1 | 2 | 3 | 4 = 0) {}

  /** True while the CRTC is asserting VSYNC (polled via PPI Port B bit 0). */
  vsyncActive = false;
  /** True for the single scanline on which VSYNC begins (for interrupt resync). */
  vsyncStart = false;

  // ── Per-frame raster counters ──────────────────────────────────────────
  private vcc = 0;          // character-row counter (0–R4)
  private ra = 0;           // raster within row (0–R9)
  private maRow = 0;        // memory address at start of current row
  private vsyncLeft = 0;    // remaining VSYNC scanlines

  selectRegister(val: number): void { this.selected = val & 0x1F; }

  writeRegister(val: number): void {
    if (this.selected < 18) this.regs[this.selected] = val & 0xFF;
  }

  readRegister(): number {
    if (this.selected >= 12 && this.selected <= 17) return this.regs[this.selected];
    if (this.type === 1 && (this.selected === 10 || this.selected === 11)) {
      return this.regs[this.selected];
    }
    return 0;
  }

  readStatus(): number { return 0; }

  /** 14-bit display start address (R12:R13). */
  get displayStart(): number {
    return (((this.regs[R_DISPLAY_START_H] & 0x3F) << 8) | this.regs[R_DISPLAY_START_L]) & 0x3FFF;
  }

  /** Characters per scanline (R0+1), clamped to a sane range while the firmware
   *  has not yet programmed the registers. */
  charsPerLine(): number {
    const n = this.regs[R_HORIZ_TOTAL] + 1;
    return n >= 16 && n <= 128 ? n : 64;
  }

  /** Total scanlines this frame ((R4+1)·(R9+1)+R5), clamped while unprogrammed. */
  linesPerFrame(): number {
    const n = (this.regs[R_VERT_TOTAL] + 1) * (this.regs[R_MAX_RASTER] + 1) + this.regs[R_VERT_ADJUST];
    return n >= 32 && n <= 400 ? n : 312;
  }

  beginFrame(): void {
    this.vcc = 0;
    this.ra = 0;
    this.maRow = this.displayStart;
    // Leave vsync state to carry naturally across the boundary.
  }

  /** State of the scanline about to be drawn. */
  currentLine(): CrtcLine {
    return {
      maRow: this.maRow,
      ra: this.ra,
      hDisplayed: this.regs[R_HORIZ_DISPLAYED],
      vDisplay: this.vcc < this.regs[R_VERT_DISPLAYED],
    };
  }

  /** Advance to the next scanline, updating VCC/RA/MA and VSYNC. */
  advanceLine(): void {
    this.vsyncStart = false;

    // VSYNC begins at the first raster of character row R7.
    if (this.vcc === this.regs[R_VSYNC_POS] && this.ra === 0 && !this.vsyncActive) {
      let width = this.regs[R_SYNC_WIDTHS] >> 4;
      if (width === 0) width = 16; // 0 means 16 lines on type 0/1
      this.vsyncActive = true;
      this.vsyncStart = true;
      this.vsyncLeft = width;
    }
    if (this.vsyncActive) {
      this.vsyncLeft--;
      if (this.vsyncLeft <= 0) this.vsyncActive = false;
    }

    // Advance raster / character row.
    if (this.ra >= this.regs[R_MAX_RASTER]) {
      this.ra = 0;
      this.vcc++;
      this.maRow = (this.maRow + this.regs[R_HORIZ_DISPLAYED]) & 0x3FFF;
    } else {
      this.ra++;
    }
  }

  reset(): void {
    this.regs.fill(0);
    this.selected = 0;
    this.vsyncActive = false;
    this.vsyncStart = false;
    this.vcc = 0;
    this.ra = 0;
    this.maRow = 0;
    this.vsyncLeft = 0;
  }
}
