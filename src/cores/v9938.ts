/**
 * Yamaha V9938 MSX-VIDEO processor — the video chip of the Tatung Einstein
 * 256 (and every MSX2). It supersedes the TMS9918A: 128KB of main VRAM plus
 * a 64KB expansion bank (both private — the CPU reaches them only through
 * four I/O ports), a 512-colour programmable palette, 80-column text and
 * bitmapped graphics modes, and a blitter command engine.
 *
 * This is the phase-1 subset, sized to boot the Einstein 256's MOS 2.1 and
 * Xtal DOS and to run TMS9918A-compatible software:
 *
 *   - 48-register file (R0–R27 masked per the data book)
 *   - 17-bit VRAM addressing (address latch + R14), read-ahead data port
 *   - palette port (port 2) and indirect register port (port 3 via R17)
 *   - status registers S0–S2 (frame flag, field flag, VR-period flag)
 *   - Text 1 / Text 2 (with the blink colour table) and Graphics 1–3
 *     scanline renderers
 *
 * Deferred to later phases: Graphics 4–7, sprite modes 1/2, the command
 * (blitter) engine, line interrupts, horizontal scroll (R26/R27) and
 * interlace. G4–G7 render as backdrop for now.
 *
 * Reference: Yamaha V9938 MSX-VIDEO Technical Data Book; MAME's
 * devices/video/v9938.cpp for the port semantics and mode-bit table.
 */

/** Active line width — all modes render into a 512-pixel line (the 256-px
 *  graphic modes double each pixel, the text modes draw 480 px centred). */
export const V9938_WIDTH = 512;
/** Maximum active display height (R9 LN selects 192 or 212 lines). */
export const V9938_HEIGHT = 212;

/** Total video RAM: 128KB main + 64KB expansion. */
export const VRAM_SIZE = 0x30000;
/** CPU-port address bits within a 16KB page. */
const ADDR_LATCH_MASK = 0x3FFF;
/** Expansion-memory window base (the second 64KB of the 192KB). */
const EXPANSION_BASE = 0x20000;

/** Pack 0xRRGGBB into the renderer's ABGR word (matches tms9918a.ts). */
const packRgb = (hex: number): number =>
  ((0xFF000000 | ((hex & 0xFF) << 16) | (hex & 0xFF00) | ((hex >> 16) & 0xFF)) >>> 0);

/** Expand a 3-bit palette component to 8 bits (bit replication). */
const pal3 = (v: number): number => (v << 5) | (v << 2) | (v >> 1);

/** Compose an ABGR pen from 3-bit R/G/B components. */
const penFromRgb = (r: number, g: number, b: number): number =>
  packRgb((pal3(r) << 16) | (pal3(g) << 8) | pal3(b));

/** Register write masks R0–R27 (data book: unused bits read back as set /
 *  are discarded on write). From MAME's v9938.cpp reg_mask[]. */
const REG_MASK: readonly number[] = [
  0x7E, 0x7B, 0x7F, 0xFF, 0x3F, 0xFF, 0x3F, 0xFF,
  0xFB, 0xBF, 0x07, 0x03, 0xFF, 0xFF, 0x07, 0x0F,
  0x0F, 0xBF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
  0x00, 0x7F, 0x3F, 0x07,
];

/** Power-up palette (V9938 Technical Data Book p.148, G-R-B 3-bit). */
const RESET_PALETTE: readonly number[] = [
  0, 0, 0, 0, 0, 0, 6, 1, 1, 7, 3, 3, 1, 1, 7, 3, 2, 7,
  1, 5, 1, 6, 2, 7, 1, 7, 1, 3, 7, 3, 6, 6, 1, 6, 6, 4,
  4, 1, 1, 2, 6, 5, 5, 5, 5, 7, 7, 7,
];

// Register bits.
const R0_IE0 = 0x10;       // line-interrupt enable (phase 2)
const R1_BL = 0x40;        // 0 = display blanked
const R1_IE1 = 0x20;       // frame-interrupt enable
const R9_LN = 0x80;        // 192 / 212 lines
const R45_MXM = 0x40;      // CPU port accesses expansion memory

// Status bits.
const S0_F = 0x80;         // frame (vblank) interrupt flag
const S1_FH = 0x01;        // line interrupt flag (phase 2)
const S2_EO = 0x02;        // odd/even field flag — toggles every frame
const S2_VR = 0x40;        // vertical retrace period flag

export type V9938Mode =
  | 'text1' | 'text2' | 'multicolor'
  | 'graphic1' | 'graphic2' | 'graphic3'
  | 'graphic4' | 'graphic5' | 'graphic6' | 'graphic7' | 'unknown';

export class V9938 {
  /** 192KB private video RAM (128KB main + 64KB expansion at 0x20000). */
  readonly vram = new Uint8Array(VRAM_SIZE);

  /** The 48 control registers (write-only on real hardware; kept readable
   *  here for debug/OCR). */
  readonly regs = new Uint8Array(48);

  /** Raw palette register pairs (GRB format) + the resolved ABGR pens. */
  private readonly palRegs = new Uint8Array(32);
  readonly pens = new Uint32Array(16);

  /** 14-bit address latch; combined with R14 for the full 17-bit address. */
  private addressLatch = 0;
  /** Read-ahead buffer for data-port reads. */
  private readAhead = 0;
  /** Control-port write latch state. */
  private controlFirst = 0;
  private controlSecond = false;
  /** Palette-port write latch state. */
  private paletteFirst = 0;
  private paletteSecond = false;

  /** Status registers S0–S9 (S3–S9 stay 0 until the command engine lands). */
  private readonly status = new Uint8Array(10);

  /** Blink state machine for the Text 2 blink colour table. */
  private blinkOn = false;
  private blinkCount = 0;

  // ── CPU interface ─────────────────────────────────────────────────────

  /** The full 17-bit CPU-port VRAM address. */
  private address(): number {
    return (this.regs[14] << 14) | this.addressLatch;
  }

  /** VRAM access honouring the expansion-memory select (R45 MXM). The
   *  expansion bank is only 64KB: with MXM set, accesses whose address has
   *  bit 16 set float (read 0xFF, write ignored). */
  private vramRead(): number {
    const addr = this.address();
    if (this.regs[45] & R45_MXM) {
      return (addr & 0x10000) ? 0xFF : this.vram[EXPANSION_BASE + addr];
    }
    return this.vram[addr];
  }

  private vramWrite(val: number): void {
    const addr = this.address();
    if (this.regs[45] & R45_MXM) {
      if (!(addr & 0x10000)) this.vram[EXPANSION_BASE + addr] = val;
    } else {
      this.vram[addr] = val;
    }
  }

  /** Auto-increment the 14-bit latch; on wrap R14 increments in the G4+
   *  modes (R0 M4/M5 set) — the documented V9938 quirk. */
  private incrementAddress(): void {
    this.addressLatch = (this.addressLatch + 1) & ADDR_LATCH_MASK;
    if (this.addressLatch === 0 && (this.regs[0] & 0x0C)) {
      this.regs[14] = (this.regs[14] + 1) & 7;
    }
  }

  /** Port 0 read: returns the read-ahead byte and prefetches the next. */
  readData(): number {
    const val = this.readAhead;
    this.readAhead = this.vramRead();
    this.incrementAddress();
    this.controlSecond = false;
    return val;
  }

  /** Port 0 write. */
  writeData(val: number): void {
    val &= 0xFF;
    this.vramWrite(val);
    this.readAhead = val;
    this.incrementAddress();
    this.controlSecond = false;
  }

  /**
   * Port 1 write. Two bytes: the first is latched; the second selects:
   *   10rrrrrr → write the first byte to register rrrrrr
   *   01aaaaaa → set address (write intent)
   *   00aaaaaa → set address (read intent) + prefetch
   *   11xxxxxx → ignored
   */
  writeControl(val: number): void {
    val &= 0xFF;
    if (!this.controlSecond) {
      this.controlFirst = val;
      this.controlSecond = true;
      return;
    }
    this.controlSecond = false;
    if (val & 0x80) {
      if (!(val & 0x40)) this.registerWrite(val & 0x3F, this.controlFirst);
    } else {
      this.addressLatch = (((val & 0x3F) << 8) | this.controlFirst) & ADDR_LATCH_MASK;
      if (!(val & 0x40)) {
        this.readAhead = this.vramRead();
        this.incrementAddress();
      }
    }
  }

  /** Port 1 read: the status register selected by R15. Reading S0 clears
   *  its upper bits (F/5S/C); reading S1 clears FH. */
  readStatus(): number {
    this.controlSecond = false;
    const reg = this.regs[15] & 0x0F;
    if (reg > 9) return 0xFF;
    const ret = this.status[reg];
    if (reg === 0) this.status[0] &= 0x1F;
    else if (reg === 1) this.status[1] &= ~S1_FH & 0xFF;
    return ret;
  }

  /** Port 2 write: palette entry. Two bytes per entry (0RRR0BBB, 00000GGG);
   *  the R16 index auto-increments. */
  writePalette(val: number): void {
    val &= 0xFF;
    if (!this.paletteSecond) {
      this.paletteFirst = val;
      this.paletteSecond = true;
      return;
    }
    this.paletteSecond = false;
    const index = this.regs[16] & 0x0F;
    this.palRegs[index * 2] = this.paletteFirst & 0x77;
    this.palRegs[index * 2 + 1] = val & 0x07;
    this.pens[index] = penFromRgb((this.paletteFirst >> 4) & 7, val & 7, this.paletteFirst & 7);
    this.regs[16] = (index + 1) & 0x0F;
  }

  /** Port 3 write: indirect register write through R17 (auto-increments
   *  unless R17 bit7 is set; never writes R17 itself). */
  writeRegister(val: number): void {
    const reg = this.regs[17] & 0x3F;
    if (reg !== 17) this.registerWrite(reg, val & 0xFF);
    if (!(this.regs[17] & 0x80)) this.regs[17] = (reg + 1) & 0x3F;
  }

  /** A register write from any port path, with data-book masking. */
  private registerWrite(reg: number, val: number): void {
    if (reg > 46) return;
    if (reg <= 27) val &= REG_MASK[reg];
    if (reg === 15) this.paletteSecond = false;
    this.regs[reg] = val;
  }

  // ── Interrupt / frame timing ──────────────────────────────────────────

  /** Start of a frame: leaves the vertical-retrace period. */
  beginFrame(): void {
    this.status[2] &= ~S2_VR & 0xFF;
  }

  /** End of the active display: raise the frame flag, enter the retrace
   *  period, flip the field flag, and advance the blink state. */
  endActiveDisplay(): void {
    this.status[0] |= S0_F;
    this.status[2] |= S2_VR;
    this.status[2] = (this.status[2] & ~S2_EO & 0xFF) | (~this.status[2] & S2_EO);
    this.advanceBlink();
  }

  /** Blink: R13 high nibble = ON period, low nibble = OFF period (in ~10
   *  frame units). Either nibble 0 pins the state, per the data book. */
  private advanceBlink(): void {
    const r13 = this.regs[13];
    const on = r13 >> 4, off = r13 & 0x0F;
    if (on === 0) { this.blinkOn = false; this.blinkCount = 0; return; }
    if (off === 0) { this.blinkOn = true; this.blinkCount = 0; return; }
    if (++this.blinkCount >= (this.blinkOn ? on : off) * 10) {
      this.blinkCount = 0;
      this.blinkOn = !this.blinkOn;
    }
  }

  /** Whether the INT output line is asserted. */
  interruptPending(): boolean {
    return ((this.regs[1] & R1_IE1) !== 0 && (this.status[0] & S0_F) !== 0)
      || ((this.regs[0] & R0_IE0) !== 0 && (this.status[1] & S1_FH) !== 0);
  }

  // ── Mode / geometry helpers ───────────────────────────────────────────

  /**
   * Screen mode from M1–M5 (R1 bits 4/3, R0 bits 1/2/3). The mode index
   * table follows MAME's set_mode():
   *   n = ((R0 & 0x0E) << 1) | ((R1 & 0x18) >> 3)
   */
  mode(): V9938Mode {
    const n = ((this.regs[0] & 0x0E) << 1) | ((this.regs[1] & 0x18) >> 3);
    switch (n) {
      case 0x02: return 'text1';
      case 0x0A: return 'text2';
      case 0x01: return 'multicolor';
      case 0x00: return 'graphic1';
      case 0x04: return 'graphic2';
      case 0x08: return 'graphic3';
      case 0x0C: return 'graphic4';
      case 0x10: return 'graphic5';
      case 0x14: return 'graphic6';
      case 0x1C: return 'graphic7';
      default: return 'unknown';
    }
  }

  /** True while the display is enabled (R1 BL set). */
  get displayEnabled(): boolean { return (this.regs[1] & R1_BL) !== 0; }

  /** Active display height: 192 or 212 lines (R9 LN). */
  get visibleHeight(): number { return (this.regs[9] & R9_LN) ? 212 : 192; }

  /** Backdrop colour word (R7 low nibble through the palette). */
  backdrop(): number {
    return this.pens[this.regs[7] & 0x0F];
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  /**
   * Render one active scanline as V9938_WIDTH ABGR pixels starting at
   * `rowStart` in `px`. The whole span is filled with the backdrop first,
   * then the mode's pattern data is drawn. Text modes centre their 480-px
   * content with 16-px margins; the 256-class graphic modes double each
   * pixel across the full width. Lines beyond the R9-selected height show
   * backdrop only.
   */
  renderScanline(px: Uint32Array, rowStart: number, y: number): void {
    const backdrop = this.backdrop();
    px.fill(backdrop, rowStart, rowStart + V9938_WIDTH);
    if (!this.displayEnabled || y < 0 || y >= this.visibleHeight) return;

    switch (this.mode()) {
      case 'text1': this.renderText(px, rowStart, y, 40); break;
      case 'text2': this.renderText(px, rowStart, y, 80); break;
      case 'graphic1': this.renderGraphic1(px, rowStart, y); break;
      case 'graphic2':
      case 'graphic3': this.renderGraphic23(px, rowStart, y); break;
      case 'multicolor': this.renderMulticolor(px, rowStart, y); break;
      // G4–G7 and invalid combinations: backdrop only (phase 2).
    }
  }

  /**
   * Text 1 (40×24) and Text 2 (80×24): 6-px-wide glyphs, global colours
   * from R7. Text 2 adds the blink colour table (R3/R10 base, R12 colours)
   * and the 17-bit name-table masks. Pattern row = (y + R23) & 7.
   */
  private renderText(px: Uint32Array, rowStart: number, y: number, cols: number): void {
    const t2 = cols === 80;
    const row = y >> 3;
    const line = (y + this.regs[23]) & 7;
    const vram = this.vram;

    const patBase = this.regs[4] << 11;
    const fg = this.pens[this.regs[7] >> 4];
    const bg = this.pens[this.regs[7] & 0x0F];
    const fgBlink = this.pens[this.regs[12] >> 4];
    const bgBlink = this.pens[this.regs[12] & 0x0F];

    let nameBase: number, nameMask: number, colourBase = 0, colourMask = 0;
    if (t2) {
      nameBase = (this.regs[2] & 0xFC) << 10;
      nameMask = ((this.regs[2] & 3) << 10) | 0x3FF;
      colourBase = ((this.regs[3] & 0xF8) << 6) + (this.regs[10] << 14);
      colourMask = ((this.regs[3] & 7) << 6) | 0x3F;
    } else {
      nameBase = this.regs[2] << 10;
      nameMask = 0xFFFF;
    }

    const margin = (V9938_WIDTH - cols * 6 * (t2 ? 1 : 2)) >> 1; // 16 px
    let x = rowStart + margin;
    let name = row * cols;
    for (let col = 0; col < cols; col++) {
      const code = vram[(nameBase + (t2 ? (name & nameMask) : name)) % VRAM_SIZE];
      const bits = vram[(patBase + code * 8 + line) % VRAM_SIZE];

      // Blink: a set bit in the colour table swaps R7 for R12 while the
      // blink phase is on (Text 2 only).
      let f = fg, b = bg;
      if (t2 && this.blinkOn) {
        const blinkByte = vram[(colourBase + ((name >> 3) & colourMask)) % VRAM_SIZE];
        if (blinkByte & (0x80 >> (name & 7))) { f = fgBlink; b = bgBlink; }
      }
      name = t2 ? name + 1 : (name + 1) & 0x3FF;

      for (let bit = 0; bit < 6; bit++) {
        const pen = (bits & (0x80 >> bit)) ? f : b;
        if (t2) {
          px[x++] = pen;
        } else {
          px[x++] = pen;
          px[x++] = pen;
        }
      }
    }
  }

  /** Graphics 1: 32×24 cells; colours from the colour table (R3/R10 base),
   *  8-pattern groups. Doubled to 512 px. */
  private renderGraphic1(px: Uint32Array, rowStart: number, y: number): void {
    const line2 = (y + this.regs[23]) & 0xFF;
    const row = line2 >> 3;
    const vram = this.vram;
    const nameBase = (this.regs[2] << 10) + row * 32;
    const colBase = (this.regs[3] << 6) + (this.regs[10] << 14);
    const patBase = this.regs[4] << 11;
    let x = rowStart;
    for (let col = 0; col < 32; col++) {
      const code = vram[(nameBase + col) % VRAM_SIZE];
      const bits = vram[(patBase + code * 8 + (line2 & 7)) % VRAM_SIZE];
      const colByte = vram[(colBase + (code >> 3)) % VRAM_SIZE];
      const fg = this.pens[colByte >> 4];
      const bg = this.pens[colByte & 0x0F];
      for (let b = 0; b < 8; b++) {
        const pen = (bits & (0x80 >> b)) ? fg : bg;
        px[x++] = pen;
        px[x++] = pen;
      }
    }
  }

  /** Graphics 2/3: per-cell patterns/colours across three vertical thirds
   *  (the shared MAME mode_graphic23 path). Doubled to 512 px. */
  private renderGraphic23(px: Uint32Array, rowStart: number, y: number): void {
    const scrolled = (y + this.regs[23]) & 0xFF;
    const vram = this.vram;
    const colMask = ((this.regs[3] & 0x7F) << 3) | 7;
    const patMask = ((this.regs[4] & 0x03) << 8) | 0xFF;
    const colBase = ((this.regs[3] & 0x80) << 6) + (this.regs[10] << 14);
    const patBase = (this.regs[4] & 0x3C) << 11;
    const nameBase = (this.regs[2] << 10) + ((scrolled >> 3) * 32);
    const third = (scrolled & 0xC0) << 2;
    const line = scrolled & 7;
    let x = rowStart;
    for (let col = 0; col < 32; col++) {
      const code = vram[(nameBase + col) % VRAM_SIZE] + third;
      const bits = vram[(patBase + ((code & patMask) << 3) + line) % VRAM_SIZE];
      const colByte = vram[(colBase + ((code & colMask) << 3) + line) % VRAM_SIZE];
      const fg = this.pens[colByte >> 4];
      const bg = this.pens[colByte & 0x0F];
      for (let b = 0; b < 8; b++) {
        const pen = (bits & (0x80 >> b)) ? fg : bg;
        px[x++] = pen;
        px[x++] = pen;
      }
    }
  }

  /** Multicolor: 64×48 grid of 4×4 colour blocks, doubled to 512 px. */
  private renderMulticolor(px: Uint32Array, rowStart: number, y: number): void {
    const line2 = (y + this.regs[23]) & 0xFF;
    const row = line2 >> 3;
    const vram = this.vram;
    const nameBase = (this.regs[2] << 10) + row * 32;
    const patBase = this.regs[4] << 11;
    const seg = (line2 >> 2) & 7;
    let x = rowStart;
    for (let col = 0; col < 32; col++) {
      const code = vram[(nameBase + col) % VRAM_SIZE];
      const colByte = vram[(patBase + code * 8 + seg) % VRAM_SIZE];
      const left = this.pens[colByte >> 4];
      const right = this.pens[colByte & 0x0F];
      for (let b = 0; b < 8; b++) px[x++] = left;
      for (let b = 0; b < 8; b++) px[x++] = right;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  reset(): void {
    this.vram.fill(0);
    this.regs.fill(0);
    this.addressLatch = 0;
    this.readAhead = 0;
    this.controlFirst = 0;
    this.controlSecond = false;
    this.paletteFirst = 0;
    this.paletteSecond = false;
    this.status.fill(0);
    // Power-up state per the data book / MAME: S2 reports the retrace and
    // border flags set.
    this.status[2] = 0x0C;
    this.status[4] = 0xFE;
    this.status[6] = 0xFC;
    this.blinkOn = false;
    this.blinkCount = 0;
    for (let i = 0; i < 16; i++) {
      const g = RESET_PALETTE[i * 3], r = RESET_PALETTE[i * 3 + 1], b = RESET_PALETTE[i * 3 + 2];
      this.palRegs[i * 2] = (r << 4) | b;
      this.palRegs[i * 2 + 1] = g;
      this.pens[i] = penFromRgb(r, g, b);
    }
  }
}
