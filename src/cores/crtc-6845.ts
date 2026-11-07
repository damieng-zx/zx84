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

import type { StateSink, StateSource } from '@/utils/state-stream.ts';

export const R_HORIZ_TOTAL = 0;
export const R_HORIZ_DISPLAYED = 1;
export const R_HSYNC_POS = 2;
export const R_SYNC_WIDTHS = 3;
export const R_VERT_TOTAL = 4;
export const R_VERT_ADJUST = 5;
export const R_VERT_DISPLAYED = 6;
export const R_VSYNC_POS = 7;
export const R_INTERLACE = 8;
export const R_MAX_RASTER = 9;
export const R_DISPLAY_START_H = 12;
export const R_DISPLAY_START_L = 13;
export const R_LIGHT_PEN_H = 16;
export const R_LIGHT_PEN_L = 17;

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

/**
 * CRTC types as the CPC world numbers them (CPCWiki "CRTC"): 0 = HD6845S /
 * UM6845, 1 = UM6845R, 2 = MC6845, 3 = AMS40489 (the Plus ASIC), 4 = AMS40226
 * (the cost-down 6128's Pre-ASIC, which behaves as type 3). Other machines
 * fit a plain 6845 and use type 0.
 */
export type CrtcType = 0 | 1 | 2 | 3 | 4;

export class Crtc6845 {
  readonly regs = new Uint8Array(18);
  private selected = 0;

  /** Implemented bits per register: R4/R6/R7/R10 are 7-bit, R5/R9/R11 5-bit,
   *  R12/R14 6-bit. On types 1/2 the VSYNC width is fixed at 16 lines, so only
   *  R3's HSYNC nibble exists (a 0 VSYNC field reads as the 16-line default). */
  private writeMask: Uint8Array;
  private _type: CrtcType;

  constructor(type: CrtcType = 0) {
    this._type = type;
    this.writeMask = maskFor(type);
  }

  /** The fitted CRTC type. */
  get type(): CrtcType { return this._type; }

  /** Swap the fitted CRTC (a Hardware-pane choice, or a snapshot's type byte).
   *  Registers keep their values: a write-only VSYNC nibble a type-1/2 chip
   *  lacks is dropped. */
  setType(type: CrtcType): void {
    this._type = type;
    this.writeMask = maskFor(type);
    this.regs[R_SYNC_WIDTHS] &= this.writeMask[R_SYNC_WIDTHS];
  }

  /** Horizontal character counter of the beam when the CPU reads a register,
   *  set by a host that knows it (the CPC) just before a read: the Plus CRTC's
   *  status registers report comparisons against it. 0 when no host sets it. */
  hcc = 0;

  /** The vertical display flip-flop (DISPTMG's vertical half): set when a
   *  frame starts at row 0 and cleared when the row counter matches R6. A
   *  6845 compares for equality, so R6 lowered below the live row keeps the
   *  display on until the next frame. */
  private vDisp = false;

  /** True while the CRTC is asserting VSYNC (polled via PPI Port B bit 0). */
  vsyncActive = false;
  /** True for the single scanline on which VSYNC begins (for interrupt resync).
   *  Set by `advanceLine()` (or `beginFrame()`) on entry to that scanline. */
  vsyncStart = false;

  // ── Per-frame raster counters ──────────────────────────────────────────
  private vcc = 0;          // character-row counter (7-bit, matched against R4)
  private ra = 0;           // raster within row (5-bit, matched against R9)
  private maRow = 0;        // memory address at start of current row
  private vsyncLeft = 0;    // remaining VSYNC scanlines
  private vtaLeft = 0;      // remaining vertical-total-adjust (R5) scanlines

  selectRegister(val: number): void { this.selected = val & 0x1F; }

  /** Currently selected register index — for snapshot save. */
  get selectedRegister(): number { return this.selected; }

  writeRegister(val: number): void {
    // R16/R17 (light pen position) are read-only on real hardware — they're
    // latched by the light-pen strobe, not writable by the CPU. Nothing here
    // models a light pen, so they simply never change.
    if (this.selected === R_LIGHT_PEN_H || this.selected === R_LIGHT_PEN_L) return;
    if (this.selected < 18) this.regs[this.selected] = val & this.writeMask[this.selected];
  }

  /**
   * Read the selected register (&BFxx), per type (CPCWiki "CRTC", register
   * read/write table):
   *   - type 0: R12–R17 read back; every other register reads 0.
   *   - types 1/2: R14–R17 read back; R12/R13 are write-only and read 0. On the
   *     UM6845R (type 1) the dummy register R31 reads &FF.
   *   - types 3/4 (ASIC / Pre-ASIC): the read map repeats every 8 registers —
   *     R16, R17, status 1, status 2, R12, R13, 0, 0 ("Extra CPC Plus Hardware
   *     Information").
   */
  readRegister(): number {
    const sel = this.selected;
    const type = this._type;
    if (type >= 3) {
      switch (sel & 7) {
        case 0: return this.regs[R_LIGHT_PEN_H];
        case 1: return this.regs[R_LIGHT_PEN_L];
        case 2: return this.plusStatus1();
        case 3: return this.plusStatus2();
        case 4: return this.regs[R_DISPLAY_START_H];
        case 5: return this.regs[R_DISPLAY_START_L];
        default: return 0;
      }
    }
    if (sel === 31 && type === 1) return 0xFF;
    if (sel >= 14 && sel <= 17) return this.regs[sel];
    if ((sel === 12 || sel === 13) && type === 0) return this.regs[sel];
    return 0;
  }

  /**
   * Read &BExx. Only the UM6845R (type 1) has a status register there: bit 6
   * is the light-pen strobe (no light pen is modelled, so 0) and bit 5 is set
   * while the vertical display is off (VCC has reached R6) until the next
   * frame starts; the other bits read 0. Types 3/4 answer with the selected
   * register, as on &BFxx. Types 0/2 decode no read here; this returns 0.
   */
  readStatus(): number {
    const type = this._type;
    if (type === 1) return this.vDisp ? 0 : 0x20;
    if (type >= 3) return this.readRegister();
    return 0;
  }

  /** Plus CRTC "status 1": bits are active low — bit 5 on the last VSYNC line,
   *  bit 4 on the last HSYNC character, bit 3 HCC = R2, bit 2 HCC = R1,
   *  bit 1 HCC = R0/2; bit 0 is 0 while HCC != R0. Bits 7/6 are of unknown
   *  function and read 0 here. */
  private plusStatus1(): number {
    const h = this.hcc;
    const r = this.regs;
    let v = 0x3E;
    if (this.vsyncActive && this.vsyncLeft === 1) v &= ~0x20;
    const width = (r[R_SYNC_WIDTHS] & 0x0F) || 16;
    if (h === ((r[R_HSYNC_POS] + width - 1) & 0xFF)) v &= ~0x10;
    if (h === r[R_HSYNC_POS]) v &= ~0x08;
    if (h === r[R_HORIZ_DISPLAYED]) v &= ~0x04;
    if (h === (r[R_HORIZ_TOTAL] >> 1)) v &= ~0x02;
    if (h === r[R_HORIZ_TOTAL]) v |= 0x01;
    return v;
  }

  /** Plus CRTC "status 2": bit 7 is 0 while the raster counter is not 0 and
   *  bit 5 is 0 on the last raster of a row (RC = R9); the other bits are of
   *  unknown function and read 0 here. */
  private plusStatus2(): number {
    let v = 0;
    if (this.ra === 0) v |= 0x80;
    if (this.ra !== this.regs[R_MAX_RASTER]) v |= 0x20;
    return v;
  }

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

  /** Interlace sync-and-video (R8 bits 1:0 = 11): the raster address steps by
   *  two within a field, so R9 is the last even raster and a character row is
   *  only (R9/2)+1 scanlines of the field — the BBC's Mode 7 (R9=18) is ten.
   *  The other interlace mode, sync only, scans like a normal frame. */
  get interlaceVideo(): boolean { return (this.regs[R_INTERLACE] & 3) === 3; }

  /** Scanlines per character row within a field. */
  private get rowLines(): number {
    const r9 = this.regs[R_MAX_RASTER];
    return this.interlaceVideo ? (r9 >> 1) + 1 : r9 + 1;
  }

  /** Total scanlines this frame ((R4+1)·rows+R5), clamped while unprogrammed. */
  linesPerFrame(): number {
    const n = (this.regs[R_VERT_TOTAL] + 1) * this.rowLines + this.regs[R_VERT_ADJUST];
    return n >= 32 && n <= 400 ? n : 312;
  }

  /** Displayed scanlines this frame (R6 character rows × (R9+1) rasters). The
   *  standard 25-row display is 200 lines; overscan games use more. Clamped to a
   *  sane range while the registers are still being programmed (fallback 200). */
  displayedLines(): number {
    const n = this.regs[R_VERT_DISPLAYED] * this.rowLines;
    return n >= 8 && n <= 400 ? n : 200;
  }

  beginFrame(): void {
    this.vcc = 0;
    this.ra = 0;
    this.vtaLeft = 0;
    this.maRow = this.displayStart;
    this.vDisp = true;
    this.checkVDisplayEnd();
    // Leave vsync state to carry naturally across the boundary, but a frame
    // that starts on row R7 (R7 = 0) begins its VSYNC on this very line.
    this.checkVsyncOnset();
  }

  /** Restart the CRTC's internal frame: reset the row/raster counters and reload
   *  the memory address from R12:R13 *live*. Reached when the vertical total
   *  (R4, re-read each row) is hit, so a mid-frame R4/R12/R13 change restarts the
   *  frame early with the new screen base — this is how hardware rupture /
   *  split-screen works. Independent of the host frame loop's line count, so a
   *  restart mid-frame simply re-bases the address for the lines below it. */
  private restartFrame(): void {
    this.vcc = 0;
    this.ra = 0;
    this.vtaLeft = 0;
    this.maRow = this.displayStart;
    this.vDisp = true;
  }

  /** Clear the vertical display flip-flop when the row counter matches R6.
   *  Types 0/1/2 make the comparison all the time (tested here on entry to
   *  every scanline); types 3/4 only at the start of a character row
   *  (CPCWiki "CRTC", VBORDER). */
  private checkVDisplayEnd(): void {
    if (this.vDisp && this.vcc === this.regs[R_VERT_DISPLAYED]
        && (this._type < 3 || this.ra === 0)) {
      this.vDisp = false;
    }
  }

  /** VSYNC begins at the start of the first raster of character row R7 — so the
   *  onset scanline itself (VCC = R7, RA = 0) already reads VSYNC high. Tested
   *  on entry to each new scanline (not after drawing it). */
  private checkVsyncOnset(): void {
    if (this.vsyncActive || this.vtaLeft > 0) return;
    if (this.vcc !== this.regs[R_VSYNC_POS] || this.ra !== 0) return;
    // Types 1/2 have no VSYNC width field (masked to 0 on write): 16 lines.
    let width = this.regs[R_SYNC_WIDTHS] >> 4;
    if (width === 0) width = 16; // 0 means 16 lines
    this.vsyncActive = true;
    this.vsyncStart = true;
    this.vsyncLeft = width;
  }

  /**
   * Character position within the scanline (0..charsPerLine) at which HSYNC
   * *ends* — the edge the CPC Gate Array counts for its raster interrupt
   * (the Gate Array counts the falling edge of the 6845's HSYNC output). HSYNC starts at R2 and lasts R3 bits 3-0 characters (0 → 16). A
   * sync that would fall outside the line (R2 beyond R0, or still running past
   * the end of the line) is reported at the end of the line, so the host keeps
   * one HSYNC per scanline.
   */
  hsyncEndChar(): number {
    const chars = this.charsPerLine();
    const start = this.regs[R_HSYNC_POS];
    const width = (this.regs[R_SYNC_WIDTHS] & 0x0F) || 16;
    const end = start + width;
    return start < chars && end <= chars ? end : chars;
  }

  /**
   * Whether HSYNC happens on this line at all. It starts when the character
   * counter equals R2, so an R2 beyond R0 never starts one; and an HSYNC
   * width of 0 is no HSYNC on types 0/1 but 16 characters on types 2/3/4
   * (CPCWiki "CRTC", R3). Without HSYNC the CPC Gate Array counts no
   * interrupt lines.
   */
  get hsyncPresent(): boolean {
    const r = this.regs;
    if ((r[R_SYNC_WIDTHS] & 0x0F) === 0 && this._type <= 1) return false;
    return r[R_HSYNC_POS] <= r[R_HORIZ_TOTAL];
  }

  /** R8 DISPTMG skew of 3 forces the display off on types 0/3/4; types 1/2
   *  implement only R8's interlace bits (CPCWiki "CRTC", R8). */
  get displaySkewOff(): boolean {
    return (this.regs[R_INTERLACE] & 0x30) === 0x30 && this._type !== 1 && this._type !== 2;
  }

  /** State of the scanline about to be drawn. */
  currentLine(): CrtcLine {
    return {
      maRow: this.maRow,
      ra: this.ra,
      hDisplayed: this.regs[R_HORIZ_DISPLAYED],
      vDisplay: this.inVerticalDisplay,
    };
  }

  /** The scanline in progress as `currentLine` gives it, field by field and
   *  without allocating, for a host that draws as the beam goes. */
  get rowAddress(): number { return this.maRow; }
  get rasterAddress(): number { return this.ra; }
  /** The vertical display flip-flop; on the UM6845R (type 1) R6 = 0 also
   *  forces the display off while it is set (CPCWiki "CRTC", DISPTMG). */
  get inVerticalDisplay(): boolean {
    return this.vDisp && (this._type !== 1 || this.regs[R_VERT_DISPLAYED] !== 0);
  }

  /** Advance to the next scanline, updating VCC/RA/MA and VSYNC. After this,
   *  `vsyncStart` is true iff VSYNC begins on the scanline just entered. */
  advanceLine(): void {
    this.vsyncStart = false;

    // The scanline just finished was one of the N VSYNC lines (the onset line
    // counts as the first), so a width of N holds VSYNC for exactly N lines.
    if (this.vsyncActive && --this.vsyncLeft <= 0) this.vsyncActive = false;

    this.stepCounters();
    this.checkVDisplayEnd();
    this.checkVsyncOnset();
  }

  /** Move the raster/row counters on by one scanline. */
  private stepCounters(): void {
    // Vertical-total-adjust: R5 extra scanlines follow the last character row,
    // then the frame restarts.
    if (this.vtaLeft > 0) {
      if (--this.vtaLeft === 0) this.restartFrame();
      return;
    }

    // Advance raster / character row. The 6845 compares its counters for
    // *equality* with R9/R4: a register written below the live counter is
    // missed, so the counter runs on to its width (RA 5-bit, VCC 7-bit) and
    // wraps before it can match again.
    if (this.ra === this.regs[R_MAX_RASTER]) {
      // End of a character row. R4 (vertical total) is re-read here, so setting
      // it to the current row mid-frame restarts the frame early — rupture.
      if (this.vcc === this.regs[R_VERT_TOTAL]) {
        const adjust = this.regs[R_VERT_ADJUST];
        if (adjust > 0) this.vtaLeft = adjust;   // run R5 adjust lines, then restart
        else this.restartFrame();
      } else {
        this.ra = 0;
        this.vcc = (this.vcc + 1) & 0x7F;
        this.maRow = (this.maRow + this.regs[R_HORIZ_DISPLAYED]) & 0x3FFF;
      }
    } else {
      this.ra = (this.ra + (this.interlaceVideo ? 2 : 1)) & 0x1F;
      // The UM6845R re-reads R12/R13 at the start of every line while VCC is
      // 0, so the screen base can change per scanline in the first row
      // (CPCWiki "CRTC", UM6845R).
      if (this.vcc === 0 && this._type === 1) this.maRow = this.displayStart;
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
    this.vtaLeft = 0;
    this.vDisp = false;
    this.hcc = 0;
  }

  // ── Internal counters (.SNA v3 mid-frame state) ─────────────────────────

  /** The row (VCC) and raster (RA) counters, the vertical-adjust lines still
   *  to run and the VSYNC lines still to run (0 when VSYNC is off). */
  get rowCounter(): number { return this.vcc; }
  get vtaRemaining(): number { return this.vtaLeft; }
  get vsyncRemaining(): number { return this.vsyncActive ? this.vsyncLeft : 0; }

  /**
   * Put the counters where a snapshot taken mid-frame left them. The row
   * address is rebuilt from R12/R13 and R1 (the 6845 only latches it at row
   * starts, and a snapshot does not carry it) and the vertical display
   * flip-flop from R6, as if the frame so far ran on the current registers.
   */
  restoreCounters(vcc: number, ra: number, vtaLeft: number, vsyncLeft: number): void {
    this.vcc = vcc & 0x7F;
    this.ra = ra & 0x1F;
    this.vtaLeft = vtaLeft & 0x1F;
    this.vsyncActive = vsyncLeft > 0;
    this.vsyncStart = false;
    this.vsyncLeft = vsyncLeft;
    this.maRow = (this.displayStart + this.vcc * this.regs[R_HORIZ_DISPLAYED]) & 0x3FFF;
    const r6 = this.regs[R_VERT_DISPLAYED];
    this.vDisp = this.vcc < r6 || (this.vcc === r6 && this._type >= 3 && this.ra !== 0);
  }

  // ── Snapshot state ────────────────────────────────────────────────────
  /** The registers, the selected register and the raster counters. */
  saveState(w: StateSink): void {
    w.raw(this.regs);
    w.u8(this.selected);
    w.bool(this.vsyncActive); w.bool(this.vsyncStart);
    w.u8(this.vcc); w.u8(this.ra); w.u16(this.maRow);
    w.u8(this.vsyncLeft); w.u8(this.vtaLeft);
  }

  loadState(r: StateSource): void {
    r.rawInto(this.regs);
    this.selected = r.u8() & 0x1F;
    this.vsyncActive = r.bool(); this.vsyncStart = r.bool();
    this.vcc = r.u8(); this.ra = r.u8(); this.maRow = r.u16();
    this.vsyncLeft = r.u8(); this.vtaLeft = r.u8();
    // The display flip-flop is not in the stream (its layout predates it):
    // rebuild it as the row compare would have left it.
    this.vDisp = this.vcc < this.regs[R_VERT_DISPLAYED];
  }
}

/** Write masks for a CRTC type (see the `writeMask` field). */
function maskFor(type: CrtcType): Uint8Array {
  return Uint8Array.from([
    0xFF, 0xFF, 0xFF, type === 1 || type === 2 ? 0x0F : 0xFF,
    0x7F, 0x1F, 0x7F, 0x7F, 0xFF, 0x1F, 0x7F, 0x1F,
    0x3F, 0xFF, 0x3F, 0xFF, 0x3F, 0xFF,
  ]);
}
