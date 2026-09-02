/**
 * Yamaha V9938 MSX-VIDEO processor — the video chip of the Tatung Einstein
 * 256 (and every MSX2). It supersedes the TMS9918A: 128KB of main VRAM plus
 * a 64KB expansion bank (both private — the CPU reaches them only through
 * four I/O ports), a 512-colour programmable palette, 80-column text and
 * bitmapped graphics modes, and a blitter command engine.
 *
 * The core implements the programmer-visible V9938 display surface: all
 * text/character/bitmap modes, both sprite engines, line and frame
 * interrupts, interlace/page selection, display adjustment, and the command
 * processor including its CPU-transfer handshakes.
 *
 *   - 48-register file (R0–R27 masked per the data book)
 *   - 17-bit VRAM addressing (address latch + R14), read-ahead data port
 *   - palette port (port 2) and indirect register port (port 3 via R17)
 *   - status registers S0–S2 (frame flag, field flag, VR-period flag)
 *   - Text 1 / Text 2 (with the blink colour table) and Graphics 1–3
 *     scanline renderers
 *
 * Command execution advances in bounded slices at scanline boundaries. This
 * preserves observable CE/TR state without putting an interface in the
 * machine's hot path.
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

/** GRAPHIC 7's fixed GGGRRRBB palette. B0 is B2 & B1. */
const pen256 = (v: number): number => {
  const r = (v >> 2) & 7;
  const g = (v >> 5) & 7;
  const b2 = (v << 1) & 6;
  const b = b2 === 6 ? 7 : b2;
  return penFromRgb(r, g, b);
};

const GRAPHIC7_SPRITE_COLOURS: readonly number[] = [
  0, 2, 192, 194, 48, 50, 240, 242,
  482, 7, 448, 455, 56, 63, 504, 511,
];

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
const S2_TR = 0x80;        // CPU transfer ready
const S2_BD = 0x10;        // SRCH found border
const S2_CE = 0x01;        // command executing

type CommandMode = 0 | 1 | 2 | 3;

interface V9938Command {
  code: number;
  op: number;
  mode: CommandMode;
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  tx: number;
  ty: number;
  srcExpansion: boolean;
  dstExpansion: boolean;
  x: number;
  y: number;
  remainingX: number;
  remainingY: number;
  lineError: number;
  lineCount: number;
  cpuWaiting: boolean;
}

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

  /** Active command-processor operation, if any. */
  private command: V9938Command | null = null;

  /** Reused scanline workspaces; rendering remains allocation-free. */
  private readonly lineBuffer = new Uint32Array(V9938_WIDTH);
  private readonly spriteLine = new Uint8Array(256);

  // ── CPU interface ─────────────────────────────────────────────────────

  /** The full 17-bit CPU-port VRAM address. */
  private address(): number {
    return (this.regs[14] << 14) | this.addressLatch;
  }

  /** VRAM access honouring the expansion-memory select (R45 MXM). The
   *  expansion bank is only 64KB: with MXM set, accesses whose address has
   *  bit 16 set float (read 0xFF, write ignored). */
  private vramRead(): number {
    let addr = this.address();
    if (this.regs[45] & R45_MXM) {
      if (this.mode() === 'graphic6' || this.mode() === 'graphic7') addr >>= 1;
      return (addr & 0x10000) ? 0xFF : this.vram[EXPANSION_BASE + addr];
    }
    return this.vram[this.mapCpuAddress(addr)];
  }

  private vramWrite(val: number): void {
    let addr = this.address();
    if (this.regs[45] & R45_MXM) {
      if (this.mode() === 'graphic6' || this.mode() === 'graphic7') addr >>= 1;
      if (!(addr & 0x10000)) this.vram[EXPANSION_BASE + addr] = val;
    } else {
      this.vram[this.mapCpuAddress(addr)] = val;
    }
  }

  /** G6/G7 interleave even and odd logical bytes across the two 64KB banks. */
  private mapCpuAddress(addr: number): number {
    const mode = this.mode();
    if (mode === 'graphic6' || mode === 'graphic7') {
      return ((addr & 1) << 16) | (addr >> 1);
    }
    return addr;
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
    else if (reg === 7) this.consumeCpuRead();
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
    // R25-R27 are V9958-only. A V9938 reads them internally as zero.
    if (reg >= 25 && reg <= 27) val = 0;
    if (reg === 15) this.paletteSecond = false;
    const oldMode = reg <= 1 ? this.mode() : null;
    this.regs[reg] = val;
    if (oldMode !== null && oldMode !== this.mode()) this.abortCommand();
    if (reg === 44) {
      this.status[7] = val;
      this.consumeCpuWrite(val);
    } else if (reg === 46) {
      this.startCommand(val);
    }
  }

  // ── Interrupt / frame timing ──────────────────────────────────────────

  /** Start of a frame: leaves the vertical-retrace period. */
  beginFrame(): void {
    this.status[2] &= ~S2_VR & 0xFF;
  }

  /**
   * Advance line-sensitive VDP state at the beginning of a physical line.
   *
   * The line (FH) interrupt fires at the right border of the matched line —
   * i.e. once that line has finished — not at its start. Since this is
   * called once per line before that line's own cycles run, the line that
   * "just finished" is `line - 1`: comparing against it here (rather than
   * `line` itself) delays the FH assert by one scanline call to land at the
   * right border instead of firing a full line early.
   */
  advanceScanline(line: number): void {
    const adjusted = (line - 1) - this.positionOffset(this.regs[18] >> 4);
    if (adjusted >= 0 && adjusted <= 255
      && (((adjusted + this.regs[23]) & 0xFF) === this.regs[19])) {
      this.status[1] |= S1_FH;
    } else if (!(this.regs[0] & R0_IE0)) {
      this.status[1] &= ~S1_FH & 0xFF;
    }
    this.runCommandSlice(1024);
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
    if (this.mode() === 'graphic7') return pen256(this.regs[7]);
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
    const mode = this.mode();
    this.fillBackdrop(px, rowStart, mode, backdrop);
    const sourceY = y - this.positionOffset(this.regs[18] >> 4);
    if (!this.displayEnabled || sourceY < 0 || sourceY >= this.visibleHeight) return;

    const line = this.lineBuffer;
    this.fillBackdrop(line, 0, mode, backdrop);
    switch (mode) {
      case 'text1': this.renderText(line, 0, sourceY, 40); break;
      case 'text2': this.renderText(line, 0, sourceY, 80); break;
      case 'graphic1': this.renderGraphic1(line, 0, sourceY); break;
      case 'graphic2':
      case 'graphic3': this.renderGraphic23(line, 0, sourceY); break;
      case 'multicolor': this.renderMulticolor(line, 0, sourceY); break;
      case 'graphic4': this.renderBitmap(line, sourceY, 0); break;
      case 'graphic5': this.renderBitmap(line, sourceY, 1); break;
      case 'graphic6': this.renderBitmap(line, sourceY, 2); break;
      case 'graphic7': this.renderBitmap(line, sourceY, 3); break;
    }

    if (mode === 'graphic1' || mode === 'graphic2' || mode === 'multicolor') {
      this.renderSprites(line, sourceY, false, mode);
    } else if (mode === 'graphic3' || mode === 'graphic4' || mode === 'graphic5'
      || mode === 'graphic6' || mode === 'graphic7') {
      this.renderSprites(line, sourceY, true, mode);
    }

    const shift = this.positionOffset(this.regs[18] & 0x0F) * 2;
    const srcStart = Math.max(0, -shift);
    const dstStart = Math.max(0, shift);
    const count = V9938_WIDTH - Math.abs(shift);
    if (count > 0) px.set(line.subarray(srcStart, srcStart + count), rowStart + dstStart);
  }

  private fillBackdrop(
    px: Uint32Array,
    start: number,
    mode: V9938Mode,
    backdrop: number,
  ): void {
    if (mode !== 'graphic5') {
      px.fill(backdrop, start, start + V9938_WIDTH);
      return;
    }
    const even = this.pens[(this.regs[7] >> 2) & 3];
    const odd = this.pens[this.regs[7] & 3];
    for (let x = 0; x < V9938_WIDTH; x += 2) {
      px[start + x] = even;
      px[start + x + 1] = odd;
    }
  }

  private positionOffset(value: number): number {
    value &= 0x0F;
    return value < 8 ? -value : 16 - value;
  }

  private palettePen(index: number, graphic5 = false): number {
    if (index === 0 && !(this.regs[8] & 0x20) && !graphic5) return this.backdrop();
    return this.pens[index & 0x0F];
  }

  /** GRAPHIC 4–7 (MSX SCREEN 5–8) bitmap scanline. */
  private renderBitmap(px: Uint32Array, y: number, mode: CommandMode): void {
    const lineMask = ((this.regs[2] & 0x1F) << 3) | 7;
    const scrolled = ((y + this.regs[23]) & lineMask) & 0xFF;
    const second = this.secondField();
    if (mode === 0 || mode === 1) {
      let addr = ((this.regs[2] & 0x40) << 10) + scrolled * 128;
      if ((this.regs[2] & 0x20) && second) addr += 0x8000;
      let x = 0;
      for (let i = 0; i < 128; i++) {
        const value = this.vram[addr + i];
        if (mode === 0) {
          const a = this.palettePen(value >> 4);
          const b = this.palettePen(value & 15);
          px[x++] = a; px[x++] = a;
          px[x++] = b; px[x++] = b;
        } else {
          for (let shift = 6; shift >= 0; shift -= 2) {
            px[x++] = this.palettePen((value >> shift) & 3, true);
          }
        }
      }
      return;
    }

    let logical = scrolled << 8;
    if ((this.regs[2] & 0x20) && second) logical += 0x10000;
    let x = 0;
    for (let i = 0; i < 256; i++) {
      const value = this.vram[((logical & 1) << 16) | (logical >> 1)];
      logical++;
      if (mode === 2) {
        px[x++] = this.palettePen(value >> 4);
        px[x++] = this.palettePen(value & 15);
      } else {
        const pen = value === 0 && !(this.regs[8] & 0x20) ? this.backdrop() : pen256(value);
        px[x++] = pen; px[x++] = pen;
      }
    }
  }

  private secondField(): boolean {
    return !((this.regs[9] & 0x04) && !(this.status[2] & S2_EO));
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

  /** Render and evaluate one sprite scanline, including overflow/collision. */
  private renderSprites(
    px: Uint32Array,
    y: number,
    mode2: boolean,
    screenMode: V9938Mode,
  ): void {
    const col = this.spriteLine;
    col.fill(0);
    if (this.regs[8] & 0x02) return;

    let attr = mode2
      ? ((this.regs[5] & 0xFC) << 7) + (this.regs[11] << 15)
      : (this.regs[5] << 7) + (this.regs[11] << 15);
    const colourBase = ((this.regs[5] & 0xF8) << 7) + (this.regs[11] << 15);
    const colourMask = ((this.regs[5] & 3) << 3) | 7;
    const patternBase = this.regs[6] << 11;
    const size = (this.regs[1] & 2) ? 16 : 8;
    const magnified = (this.regs[1] & 1) !== 0;
    const height = size * (magnified ? 2 : 1);
    const limit = mode2 ? 8 : 4;
    const terminator = mode2 ? 216 : 208;
    let visible = 0;
    let lastSprite = 31;
    let baseSeen = false;

    for (let sprite = 0; sprite < 32; sprite++, attr += 4) {
      let sy = this.displayVramRead(attr);
      if (sy === terminator) { lastSprite = sprite; break; }
      sy = (sy - this.regs[23]) & 0xFF;
      sy = sy > terminator ? -((~sy) & 0xFF) : sy + 1;
      if (y < sy || y >= sy + height) continue;

      if (visible === limit) {
        if (!(this.status[0] & 0xC0)) {
          this.status[0] = (this.status[0] & 0xA0) | 0x40 | sprite;
        }
        break;
      }
      visible++;

      let line = y - sy;
      if (magnified) line >>= 1;
      let colour = mode2
        ? this.displayVramRead(colourBase + ((sprite & colourMask) * 16) + line)
        : this.displayVramRead(attr + 3);
      const cc = mode2 && (colour & 0x40) !== 0;
      const collisionEnabled = !mode2 || (colour & 0x60) === 0;
      if (!cc) baseSeen = true;
      if (cc && !baseSeen) continue;

      let sx = this.displayVramRead(attr + 1);
      if (colour & 0x80) sx -= 32;
      let pattern = this.displayVramRead(attr + 2);
      if (size === 16) pattern &= 0xFC;
      const patternAddr = patternBase + pattern * 8 + line;
      let bits = this.displayVramRead(patternAddr) << 8;
      if (size === 16) bits |= this.displayVramRead(patternAddr + 16);
      const count = size;
      colour &= 0x0F;

      for (let bit = 0; bit < count; bit++) {
        const solid = (bits & (0x8000 >> bit)) !== 0;
        const repeat = magnified ? 2 : 1;
        for (let zoom = 0; zoom < repeat; zoom++) {
          const x = sx + bit * repeat + zoom;
          if (x < 0 || x >= 256 || !solid) continue;

          if (collisionEnabled && (colour & 0x0F) !== 0 && (col[x] & 0x40)) {
            this.setSpriteCollision(x, y);
          }
          if (collisionEnabled && (colour & 0x0F) !== 0) col[x] |= 0x40;

          if (colour !== 0 || (this.regs[8] & 0x20)) {
            if (cc && (col[x] & 0x80)) {
              col[x] = (col[x] & 0xF0) | ((col[x] | colour) & 0x0F);
            } else if (!(col[x] & 0x80)) {
              col[x] |= 0x80 | colour;
            }
          }
        }
      }
    }

    if (!(this.status[0] & 0x40)) {
      this.status[0] = (this.status[0] & 0xA0) | (lastSprite & 0x1F);
    }

    for (let x = 0; x < 256; x++) {
      if (!(col[x] & 0x80)) continue;
      const colour = col[x] & 0x0F;
      const dst = x * 2;
      if (screenMode === 'graphic5') {
        px[dst] = this.pens[(colour >> 2) & 3];
        px[dst + 1] = this.pens[colour & 3];
      } else if (screenMode === 'graphic7') {
        const encoded = GRAPHIC7_SPRITE_COLOURS[colour];
        px[dst] = px[dst + 1] = penFromRgb(
          (encoded >> 6) & 7,
          (encoded >> 3) & 7,
          encoded & 7,
        );
      } else {
        px[dst] = px[dst + 1] = this.pens[colour];
      }
    }
  }

  private displayVramRead(addr: number): number {
    const mode = this.mode();
    if (mode === 'graphic6' || mode === 'graphic7') {
      return this.vram[((addr & 1) << 16) | (addr >> 1)];
    }
    return this.vram[addr];
  }

  private setSpriteCollision(x: number, y: number): void {
    if (this.status[0] & 0x20) return;
    this.status[0] |= 0x20;
    // The V9938 reports collision coordinates in its internal timing space:
    // active-display X/Y are biased by 12 and 8 respectively.
    x += 12;
    y += 8;
    this.status[3] = x & 0xFF;
    this.status[4] = 0xFE | ((x >> 8) & 1);
    this.status[5] = y & 0xFF;
    this.status[6] = 0xFC | ((this.status[2] & S2_EO) ? 2 : 0) | ((y >> 8) & 1);
  }

  // ── Command processor ───────────────────────────────────────────────

  private commandMode(): CommandMode | null {
    switch (this.mode()) {
      case 'graphic4': return 0;
      case 'graphic5': return 1;
      case 'graphic6': return 2;
      case 'graphic7': return 3;
      default: return null;
    }
  }

  private startCommand(value: number): void {
    const code = value >> 4;
    if (code === 0) { this.abortCommand(); return; }
    if (code < 4) return;
    const mode = this.commandMode();
    if (mode === null) return;

    const sx = (this.regs[32] | (this.regs[33] << 8)) & 0x1FF;
    const sy = (this.regs[34] | (this.regs[35] << 8)) & 0x3FF;
    const dx = (this.regs[36] | (this.regs[37] << 8)) & 0x1FF;
    const dy = (this.regs[38] | (this.regs[39] << 8)) & 0x3FF;
    const ppb = [2, 4, 2, 1][mode];
    const highSpeed = code >= 0x0C;
    let nx = (this.regs[40] | (this.regs[41] << 8)) & 0x3FF;
    let ny = (this.regs[42] | (this.regs[43] << 8)) & 0x3FF;
    if (code !== 7) {
      if (nx === 0) nx = 1024;
      if (ny === 0) ny = 1024;
    }
    if (highSpeed) nx = Math.max(1, Math.floor(nx / ppb));

    // POINT and PSET are immediate and do not assert CE.
    if (code === 4) {
      const colour = this.point(mode, (this.regs[45] & 0x10) !== 0, sx, sy);
      this.regs[44] = this.status[7] = colour;
      this.status[2] &= ~(S2_CE | S2_TR) & 0xFF;
      return;
    }
    if (code === 5) {
      this.pset(mode, (this.regs[45] & 0x20) !== 0, dx, dy, this.regs[44], value & 0x0F);
      this.status[2] &= ~(S2_CE | S2_TR) & 0xFF;
      return;
    }

    if (code === 0x0E) {
      const width = [256, 512, 512, 256][mode];
      nx = (this.regs[45] & 0x04)
        ? Math.floor(dx / ppb) + 1
        : Math.ceil((width - dx) / ppb);
    }

    this.command = {
      code,
      op: value & 0x0F,
      mode,
      sx, sy, dx, dy, nx, ny,
      tx: (this.regs[45] & 0x04) ? -(highSpeed ? ppb : 1) : (highSpeed ? ppb : 1),
      ty: (this.regs[45] & 0x08) ? -1 : 1,
      srcExpansion: (this.regs[45] & 0x10) !== 0,
      dstExpansion: (this.regs[45] & 0x20) !== 0,
      x: 0,
      y: 0,
      remainingX: nx,
      remainingY: ny,
      lineError: Math.max(0, (nx - 1) >> 1),
      lineCount: 0,
      cpuWaiting: code === 0x0A || code === 0x0B || code === 0x0F,
    };
    this.status[2] = (this.status[2] | S2_CE) & ~S2_TR;

    if (code === 0x0A) this.prepareCpuRead();
    else if (code === 0x0B || code === 0x0F) this.status[2] |= S2_TR;
  }

  private abortCommand(): void {
    this.command = null;
    this.status[2] &= ~(S2_CE | S2_TR) & 0xFF;
  }

  private finishCommand(): void {
    const c = this.command;
    if (c === null) return;
    const finalSy = (c.sy + c.y * c.ty) & 0x3FF;
    const finalDy = (c.dy + c.y * c.ty) & 0x3FF;
    this.regs[34] = finalSy & 0xFF;
    this.regs[35] = (finalSy >> 8) & 3;
    this.regs[38] = finalDy & 0xFF;
    this.regs[39] = (finalDy >> 8) & 3;
    this.regs[42] = 0;
    this.regs[43] = 0;
    this.abortCommand();
  }

  private advanceCommandPosition(c: V9938Command): boolean {
    c.x++;
    const width = [256, 512, 512, 256][c.mode];
    const srcX = c.sx + c.x * c.tx;
    const dstX = c.dx + c.x * c.tx;
    const sourceUsed = c.code === 9 || c.code === 0x0A || c.code === 0x0D;
    const destUsed = c.code !== 0x0A;
    const inBounds = (!sourceUsed || (srcX >= 0 && srcX < width))
      && (!destUsed || (dstX >= 0 && dstX < width));
    if (c.x < c.nx && inBounds) return false;
    c.x = 0;
    c.y++;
    return c.y >= c.ny
      || ((c.sy + c.y * c.ty) < 0)
      || ((c.dy + c.y * c.ty) < 0);
  }

  private consumeCpuWrite(value: number): void {
    const c = this.command;
    if (c === null || !(this.status[2] & S2_TR)
      || (c.code !== 0x0B && c.code !== 0x0F)) return;
    this.status[2] &= ~S2_TR & 0xFF;
    const x = c.dx + c.x * c.tx;
    const y = c.dy + c.y * c.ty;
    if (c.code === 0x0B) this.pset(c.mode, c.dstExpansion, x, y, value, c.op);
    else this.writeCommandByte(c.mode, c.dstExpansion, x, y, value);
    if (this.advanceCommandPosition(c)) this.finishCommand();
    else this.status[2] |= S2_TR;
  }

  private prepareCpuRead(): void {
    const c = this.command;
    if (c === null || c.code !== 0x0A) return;
    const x = c.sx + c.x * c.tx;
    const y = c.sy + c.y * c.ty;
    this.regs[44] = this.status[7] = this.point(c.mode, c.srcExpansion, x, y);
    this.status[2] |= S2_TR;
  }

  private consumeCpuRead(): void {
    const c = this.command;
    if (c === null || c.code !== 0x0A || !(this.status[2] & S2_TR)) return;
    this.status[2] &= ~S2_TR & 0xFF;
    if (this.advanceCommandPosition(c)) this.finishCommand();
    else this.prepareCpuRead();
  }

  private runCommandSlice(budget: number): void {
    const c = this.command;
    if (c === null || c.cpuWaiting) return;
    while (budget-- > 0 && this.command === c) {
      const sx = c.sx + c.x * c.tx;
      const sy = c.sy + c.y * c.ty;
      const dx = c.dx + c.x * c.tx;
      const dy = c.dy + c.y * c.ty;

      switch (c.code) {
        case 6: { // SRCH
          const equal = this.point(c.mode, c.srcExpansion, sx, sy) === (this.regs[44] & [15, 3, 15, 255][c.mode]);
          if (equal !== ((this.regs[45] & 0x02) !== 0)) {
            this.status[2] |= S2_BD;
            this.status[8] = sx & 0xFF;
            this.status[9] = 0xFE | ((sx >> 8) & 1);
            this.finishCommand();
            continue;
          }
          const width = [256, 512, 512, 256][c.mode];
          if (sx + c.tx < 0 || sx + c.tx >= width) {
            this.status[2] &= ~S2_BD & 0xFF;
            this.finishCommand();
            continue;
          }
          c.x++;
          break;
        }
        case 7:
          this.stepLine(c);
          break;
        case 8: // LMMV
          this.pset(c.mode, c.dstExpansion, dx, dy, this.regs[44], c.op);
          if (this.advanceCommandPosition(c)) this.finishCommand();
          break;
        case 9: // LMMM
          this.pset(c.mode, c.dstExpansion, dx, dy,
            this.point(c.mode, c.srcExpansion, sx, sy), c.op);
          if (this.advanceCommandPosition(c)) this.finishCommand();
          break;
        case 0x0C: // HMMV
          this.writeCommandByte(c.mode, c.dstExpansion, dx, dy, this.regs[44]);
          if (this.advanceCommandPosition(c)) this.finishCommand();
          break;
        case 0x0D: // HMMM
          this.writeCommandByte(c.mode, c.dstExpansion, dx, dy,
            this.readCommandByte(c.mode, c.srcExpansion, sx, sy));
          if (this.advanceCommandPosition(c)) this.finishCommand();
          break;
        case 0x0E: // YMMM
          this.writeCommandByte(c.mode, c.dstExpansion, dx, dy,
            this.readCommandByte(c.mode, c.dstExpansion, dx, sy));
          if (this.advanceCommandPosition(c)) this.finishCommand();
          break;
        default:
          this.finishCommand();
          break;
      }
    }
  }

  private stepLine(c: V9938Command): void {
    const majorY = (this.regs[45] & 1) !== 0;
    const major = c.nx;
    const minor = c.ny;
    this.pset(c.mode, c.dstExpansion, c.dx, c.dy, this.regs[44], c.op);
    c.lineCount++;
    if (c.lineCount > major) { this.finishCommand(); return; }
    if (majorY) c.dy += c.ty;
    else c.dx += c.tx;
    c.lineError -= minor;
    if (c.lineError < 0) {
      c.lineError += major;
      if (majorY) c.dx += c.tx;
      else c.dy += c.ty;
    }
  }

  private commandAddress(mode: CommandMode, expansion: boolean, x: number, y: number): number {
    if (expansion) {
      return EXPANSION_BASE + ((y & 0x1FF) << 7)
        + ((x & [255, 511, 511, 255][mode]) >> [1, 2, 1, 0][mode]);
    }
    switch (mode) {
      case 0: return ((y & 0x3FF) << 7) + ((x & 255) >> 1);
      case 1: return ((y & 0x3FF) << 7) + ((x & 511) >> 2);
      case 2: return ((x & 2) << 15) + ((y & 0x1FF) << 7) + ((x & 511) >> 2);
      case 3: return ((x & 1) << 16) + ((y & 0x1FF) << 7) + ((x >> 1) & 127);
    }
  }

  private point(mode: CommandMode, expansion: boolean, x: number, y: number): number {
    const value = this.vram[this.commandAddress(mode, expansion, x, y)];
    switch (mode) {
      case 0:
      case 2: return (value >> (((~x) & 1) << 2)) & 15;
      case 1: return (value >> (((~x) & 3) << 1)) & 3;
      case 3: return value;
    }
  }

  private pset(
    mode: CommandMode,
    expansion: boolean,
    x: number,
    y: number,
    colour: number,
    op: number,
  ): void {
    const addr = this.commandAddress(mode, expansion, x, y);
    const shifts = [((~x) & 1) << 2, ((~x) & 3) << 1, ((~x) & 1) << 2, 0];
    const masks = [15, 3, 15, 255];
    const shift = shifts[mode];
    const pixelMask = masks[mode];
    const src = colour & pixelMask;
    if (op & 8 && src === 0) return;
    const oldByte = this.vram[addr];
    const old = (oldByte >> shift) & pixelMask;
    let result: number;
    switch (op & 7) {
      case 0: result = src; break;
      case 1: result = old & src; break;
      case 2: result = old | src; break;
      case 3: result = old ^ src; break;
      case 4: result = (~src) & pixelMask; break;
      default: return;
    }
    this.vram[addr] = (oldByte & ~(pixelMask << shift)) | (result << shift);
  }

  private readCommandByte(mode: CommandMode, expansion: boolean, x: number, y: number): number {
    return this.vram[this.commandAddress(mode, expansion, x, y)];
  }

  private writeCommandByte(
    mode: CommandMode,
    expansion: boolean,
    x: number,
    y: number,
    value: number,
  ): void {
    this.vram[this.commandAddress(mode, expansion, x, y)] = value & 0xFF;
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
    this.command = null;
    for (let i = 0; i < 16; i++) {
      const g = RESET_PALETTE[i * 3], r = RESET_PALETTE[i * 3 + 1], b = RESET_PALETTE[i * 3 + 2];
      this.palRegs[i * 2] = (r << 4) | b;
      this.palRegs[i * 2 + 1] = g;
      this.pens[i] = penFromRgb(r, g, b);
    }
  }
}
