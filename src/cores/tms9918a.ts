/**
 * TMS9918A / TMS9929A Video Display Processor.
 *
 * The video chip of the MSX1, ColecoVision, SG-1000, TI-99/4A — and the Tatung
 * Einstein. It is nothing like the Spectrum ULA or the CPC Gate Array: it owns
 * its own private 16KB VRAM (the CPU never addresses it directly — only through
 * two I/O ports), generates a 256×192 display with a fixed 15-colour palette and
 * hardware sprites, and raises an end-of-active-display interrupt each frame.
 *
 * This core is machine-agnostic: it exposes the two-port CPU interface, the
 * status/interrupt state, and a per-scanline RGBA renderer. The host machine
 * decodes its own I/O addresses onto {@link readData}/{@link writeData}/
 * {@link readStatus}/{@link writeControl}, polls {@link interruptPending}, and
 * drives {@link renderScanline} for the 192 active lines.
 *
 * Modes implemented: Text (40×24), Graphics I, Graphics II, plus sprites.
 * Multicolor mode and exact 5th-sprite/coincidence reporting are approximations.
 *
 * References: TI TMS9918A/TMS9928A/TMS9929A datasheet; Sean Young's
 * "TMS9918.txt"; the standard MSX SCREEN 0/1/2 addressing.
 */

/** Active display geometry (border is a host/display concern). */
export const VDP_WIDTH = 256;
export const VDP_HEIGHT = 192;

/** Pack 0xRRGGBB into the renderer's ABGR word (matches cores/ula.ts PALETTES
 *  and cpc/constants.ts — 0xAABBGGRR little-endian → R,G,B,A bytes). */
const packRgb = (hex: number): number =>
  ((0xFF000000 | ((hex & 0xFF) << 16) | (hex & 0xFF00) | ((hex >> 16) & 0xFF)) >>> 0);

/**
 * The 15 TMS9918A colours + transparent (index 0). RGB values are the widely
 * used measured-TMS9918A set (Sean Young). Index 0 (transparent) is stored as
 * black but is never drawn directly — a transparent pixel shows the backdrop.
 */
export const TMS9918_PALETTE: Uint32Array = Uint32Array.from([
  0x000000, // 0  transparent (shows backdrop)
  0x000000, // 1  black
  0x21C842, // 2  medium green
  0x5EDC78, // 3  light green
  0x5455ED, // 4  dark blue
  0x7D76FC, // 5  light blue
  0xD4524D, // 6  dark red
  0x42EBF5, // 7  cyan
  0xFC5554, // 8  medium red
  0xFF7978, // 9  light red
  0xD4C154, // 10 dark yellow
  0xE6CE80, // 11 light yellow
  0x21B03B, // 12 dark green
  0xC95BBA, // 13 magenta
  0xCCCCCC, // 14 gray
  0xFFFFFF, // 15 white
].map(packRgb));

// Register 1 bits.
const R1_BLANK = 0x40;    // 0 = display blanked to backdrop
const R1_IE = 0x20;       // interrupt enable
const R1_M1 = 0x10;       // mode bit 1 (Text)
const R1_M2 = 0x08;       // mode bit 2 (Multicolor)
const R1_SPRITE_SIZE = 0x02; // 0 = 8×8, 1 = 16×16
const R1_SPRITE_MAG = 0x01;  // sprite magnification ×2

// Register 0 bits.
const R0_M3 = 0x02;       // mode bit 3 (Graphics II)

// Status register bits.
const ST_INT = 0x80;      // frame interrupt flag (F)
const ST_5S = 0x40;       // fifth-sprite flag
const ST_COINC = 0x20;    // sprite coincidence flag

const VRAM_SIZE = 0x4000; // 16KB
const VRAM_MASK = 0x3FFF;

export type VdpMode = 'text' | 'graphics1' | 'graphics2' | 'multicolor';

export class Tms9918a {
  /** Private 16KB video RAM. The CPU reaches it only via the data port. */
  readonly vram = new Uint8Array(VRAM_SIZE);

  /** The 8 write-only mode registers (R0–R7). */
  readonly regs = new Uint8Array(8);

  /** Read/write auto-incrementing 14-bit VRAM address. */
  private address = 0;

  /** Control-port write latch: false = expecting first byte. */
  private secondByte = false;
  private firstByte = 0;

  /** Read-ahead buffer for the data port (a data read returns the previous
   *  fetch and prefetches the byte at the new address). */
  private readBuffer = 0;

  /** Status register (F / 5S / coincidence / fifth-sprite number). */
  private status = 0;

  /** Active colour map (ABGR, indexed 0–15). Swappable by display settings. */
  palette: Uint32Array = TMS9918_PALETTE;

  // ── CPU interface ─────────────────────────────────────────────────────

  /** Data-port read (auto-increment, read-ahead buffered). */
  readData(): number {
    const val = this.readBuffer;
    this.readBuffer = this.vram[this.address];
    this.address = (this.address + 1) & VRAM_MASK;
    this.secondByte = false; // any data access resets the control latch
    return val;
  }

  /** Data-port write (auto-increment). */
  writeData(val: number): void {
    val &= 0xFF;
    this.vram[this.address] = val;
    this.readBuffer = val;
    this.address = (this.address + 1) & VRAM_MASK;
    this.secondByte = false;
  }

  /** Status-port read — returns the status register and clears the interrupt
   *  flag and the control-write latch (as the real chip does). */
  readStatus(): number {
    const s = this.status;
    this.status &= ~(ST_INT | ST_5S | ST_COINC) & 0xFF;
    this.secondByte = false;
    return s;
  }

  /**
   * Control-port write. Two bytes: the first is latched; the second's top two
   * bits select the action:
   *   00xxxxxx → set VRAM address for reading (and prefetch)
   *   01xxxxxx → set VRAM address for writing
   *   10000rrr → write the first byte to register rrr
   */
  writeControl(val: number): void {
    val &= 0xFF;
    if (!this.secondByte) {
      this.firstByte = val;
      this.secondByte = true;
      return;
    }
    this.secondByte = false;
    if (val & 0x80) {
      // Register write.
      this.regs[val & 0x07] = this.firstByte;
    } else {
      this.address = (((val & 0x3F) << 8) | this.firstByte) & VRAM_MASK;
      if ((val & 0x40) === 0) {
        // Read setup: prefetch the first byte.
        this.readBuffer = this.vram[this.address];
        this.address = (this.address + 1) & VRAM_MASK;
      }
    }
  }

  // ── Interrupt ─────────────────────────────────────────────────────────

  /** Assert the frame interrupt flag — call once per frame at the end of the
   *  active display. The INT line is (flag AND interrupt-enable). */
  raiseFrameInterrupt(): void {
    this.status |= ST_INT;
  }

  /** Whether the INT output line is currently asserted. */
  interruptPending(): boolean {
    return (this.status & ST_INT) !== 0 && (this.regs[1] & R1_IE) !== 0;
  }

  // ── Mode / geometry helpers ───────────────────────────────────────────

  mode(): VdpMode {
    const r1 = this.regs[1];
    if (r1 & R1_M1) return 'text';
    if (r1 & R1_M2) return 'multicolor';
    if (this.regs[0] & R0_M3) return 'graphics2';
    return 'graphics1';
  }

  /** True while the display is enabled (R1 BLANK bit set). */
  get displayEnabled(): boolean { return (this.regs[1] & R1_BLANK) !== 0; }

  /** Backdrop colour word (R7 low nibble; colour 0 → black). */
  backdrop(): number {
    return this.palette[this.regs[7] & 0x0F];
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  /**
   * Render one active scanline (y = 0..191) as 256 RGBA pixels starting at
   * `rowStart` in `px`. Fills the whole 256-wide span with the backdrop first
   * (so a blanked display, text-mode side margins, and transparent pixels all
   * show through), then draws the mode's pattern data, then overlays sprites.
   */
  renderScanline(px: Uint32Array, rowStart: number, y: number): void {
    const backdrop = this.backdrop();
    px.fill(backdrop, rowStart, rowStart + VDP_WIDTH);
    if (!this.displayEnabled || y < 0 || y >= VDP_HEIGHT) return;

    switch (this.mode()) {
      case 'text': this.renderText(px, rowStart, y); break;
      case 'graphics1': this.renderGraphics1(px, rowStart, y); break;
      case 'graphics2': this.renderGraphics2(px, rowStart, y); break;
      case 'multicolor': this.renderMulticolor(px, rowStart, y); break;
    }

    // Sprites are not displayed in Text mode.
    if (this.mode() !== 'text') this.renderSprites(px, rowStart, y);
  }

  private nameBase(): number { return (this.regs[2] & 0x0F) << 10; }

  /** Text mode: 40×24 monochrome, 6×8 cells, colours from R7. The 240-pixel
   *  active area is centred in the 256-wide line (8px backdrop each side). */
  private renderText(px: Uint32Array, rowStart: number, y: number): void {
    const row = y >> 3;
    const line = y & 7;
    const nameAddr = this.nameBase() + row * 40;
    const patBase = (this.regs[4] & 0x07) << 11;
    const fg = this.palette[(this.regs[7] >> 4) & 0x0F];
    const fgIsTransparent = ((this.regs[7] >> 4) & 0x0F) === 0;
    let x = 8; // left margin
    for (let col = 0; col < 40; col++) {
      const name = this.vram[(nameAddr + col) & VRAM_MASK];
      const bits = this.vram[(patBase + name * 8 + line) & VRAM_MASK];
      for (let b = 0; b < 6; b++) {
        if (bits & (0x80 >> b)) { if (!fgIsTransparent) px[rowStart + x] = fg; }
        // background bit: leave the backdrop already filled.
        x++;
      }
    }
  }

  /** Graphics I: 32×24 cells; 8-pattern colour groups from the colour table. */
  private renderGraphics1(px: Uint32Array, rowStart: number, y: number): void {
    const row = y >> 3;
    const line = y & 7;
    const nameAddr = this.nameBase() + row * 32;
    const patBase = (this.regs[4] & 0x07) << 11;
    const colBase = this.regs[3] << 6;
    let x = 0;
    for (let col = 0; col < 32; col++) {
      const name = this.vram[(nameAddr + col) & VRAM_MASK];
      const bits = this.vram[(patBase + name * 8 + line) & VRAM_MASK];
      const colByte = this.vram[(colBase + (name >> 3)) & VRAM_MASK];
      const fg = colByte >> 4;
      const bg = colByte & 0x0F;
      for (let b = 0; b < 8; b++) {
        const ci = (bits & (0x80 >> b)) ? fg : bg;
        if (ci !== 0) px[rowStart + x] = this.palette[ci];
        x++;
      }
    }
  }

  /** Graphics II: per-cell patterns/colours, three vertical thirds each with
   *  their own 2KB pattern/colour page (selected by R4 bit2 / R3 bit7 bases and
   *  the third offset, masked by the low R4/R3 bits). */
  private renderGraphics2(px: Uint32Array, rowStart: number, y: number): void {
    const row = y >> 3;
    const line = y & 7;
    const nameAddr = this.nameBase() + row * 32;
    const patBase = (this.regs[4] & 0x04) << 11;   // 0x0000 or 0x2000
    const colBase = (this.regs[3] & 0x80) << 6;     // 0x0000 or 0x2000
    const patMask = ((this.regs[4] & 0x03) << 8) | 0xFF;
    const colMask = ((this.regs[3] & 0x7F) << 3) | 0x07;
    const third = (row >> 3) & 3;                    // 0..2
    let x = 0;
    for (let col = 0; col < 32; col++) {
      const name = this.vram[(nameAddr + col) & VRAM_MASK];
      const patternNum = name + (third << 8);        // 0..767
      const bits = this.vram[(patBase + ((patternNum & patMask) << 3) + line) & VRAM_MASK];
      const colByte = this.vram[(colBase + ((patternNum & colMask) << 3) + line) & VRAM_MASK];
      const fg = colByte >> 4;
      const bg = colByte & 0x0F;
      for (let b = 0; b < 8; b++) {
        const ci = (bits & (0x80 >> b)) ? fg : bg;
        if (ci !== 0) px[rowStart + x] = this.palette[ci];
        x++;
      }
    }
  }

  /** Multicolor: 64×48 grid of 4×4 colour blocks. */
  private renderMulticolor(px: Uint32Array, rowStart: number, y: number): void {
    const row = y >> 3;
    const nameAddr = this.nameBase() + row * 32;
    const patBase = (this.regs[4] & 0x07) << 11;
    // Which of the two 4-pixel-tall colour nibbles this scanline uses.
    const half = (y >> 2) & 1;
    let x = 0;
    for (let col = 0; col < 32; col++) {
      const name = this.vram[(nameAddr + col) & VRAM_MASK];
      const seg = (row & 3) * 2 + half;
      const colByte = this.vram[(patBase + name * 8 + seg) & VRAM_MASK];
      const left = colByte >> 4;
      const right = colByte & 0x0F;
      for (let b = 0; b < 4; b++) { if (left !== 0) px[rowStart + x] = this.palette[left]; x++; }
      for (let b = 0; b < 4; b++) { if (right !== 0) px[rowStart + x] = this.palette[right]; x++; }
    }
  }

  /**
   * Overlay sprites on one scanline. Up to 32 sprites, 4 visible per line; the
   * 5th sets the fifth-sprite flag. Size (8/16) and magnification come from R1.
   * `y` is 0..191. Sprite colour 0 is transparent; the early-clock (EC) bit
   * shifts a sprite 32px left.
   */
  private renderSprites(px: Uint32Array, rowStart: number, y: number): void {
    const attrBase = (this.regs[5] & 0x7F) << 7;
    const patBase = (this.regs[6] & 0x07) << 11;
    const size16 = (this.regs[1] & R1_SPRITE_SIZE) !== 0;
    const mag = (this.regs[1] & R1_SPRITE_MAG) !== 0 ? 2 : 1;
    const dim = size16 ? 16 : 8;      // logical pixel size
    const height = dim * mag;         // on-screen size

    let visible = 0;
    for (let s = 0; s < 32; s++) {
      const a = (attrBase + s * 4) & VRAM_MASK;
      let sy = this.vram[a];
      if (sy === 0xD0) break;         // terminator: no more sprites
      // Sprite Y is "one less than the top row"; 0xE0..0xFF wraps above the top.
      sy = (sy + 1) & 0xFF;
      if (sy >= 0xE1) sy -= 256;
      const dy = y - sy;
      if (dy < 0 || dy >= height) continue;

      if (++visible > 4) { this.setFifthSprite(s); break; }

      const sx0 = this.vram[a + 1];
      const patternIdx = this.vram[a + 2];
      const colByte = this.vram[a + 3];
      const ci = colByte & 0x0F;
      const ec = (colByte & 0x80) !== 0 ? -32 : 0;
      if (ci === 0) continue;         // transparent sprite draws nothing
      const colour = this.palette[ci];

      const patRow = (dy / mag) | 0;  // 0..dim-1
      // 16×16 sprites are 4 quadrants: pattern index masked to a multiple of 4.
      const baseIdx = size16 ? (patternIdx & 0xFC) : patternIdx;
      const rowBits0 = this.vram[(patBase + baseIdx * 8 + patRow) & VRAM_MASK];
      const rowBits1 = size16 ? this.vram[(patBase + baseIdx * 8 + patRow + 16) & VRAM_MASK] : 0;

      for (let px16 = 0; px16 < dim; px16++) {
        const bitSet = px16 < 8
          ? (rowBits0 & (0x80 >> px16)) !== 0
          : (rowBits1 & (0x80 >> (px16 - 8))) !== 0;
        if (!bitSet) continue;
        for (let m = 0; m < mag; m++) {
          const x = sx0 + ec + px16 * mag + m;
          if (x >= 0 && x < VDP_WIDTH) px[rowStart + x] = colour;
        }
      }
    }
  }

  private setFifthSprite(n: number): void {
    // Only latch the first over-limit occurrence per frame.
    if ((this.status & ST_5S) === 0) {
      this.status = (this.status & 0xE0) | (n & 0x1F) | ST_5S;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  reset(): void {
    this.vram.fill(0);
    this.regs.fill(0);
    this.address = 0;
    this.secondByte = false;
    this.firstByte = 0;
    this.readBuffer = 0;
    this.status = 0;
  }
}
