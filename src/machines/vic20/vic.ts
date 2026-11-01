/**
 * The MOS 6560 (NTSC) / 6561 (PAL) Video Interface Chip: the VIC-20's video
 * (and, from Phase 2 of the plan, its sound).
 *
 * Registers ($9000-$900F, repeated every 16 bytes to $90FF):
 *
 *   $9000  bit 7 interlace; bits 0-6 horizontal origin, in cycles (4 pixels)
 *   $9001  vertical origin, in pairs of lines
 *   $9002  bit 7 screen address bit 9; bits 0-6 number of columns
 *   $9003  bit 7 raster line bit 0; bits 1-6 number of rows; bit 0 8×16 characters
 *   $9004  raster line bits 8-1
 *   $9005  bits 4-7 screen address bits 10-13; bits 0-3 character address bits 10-13
 *   $9006  light pen X, $9007 light pen Y
 *   $9008  paddle X, $9009 paddle Y
 *   $900A-$900C  tone voices, $900D noise (bit 7 on, bits 0-6 frequency)
 *   $900E  bits 4-7 auxiliary colour; bits 0-3 volume
 *   $900F  bits 4-7 background colour; bit 3 normal (1) or reverse (0) mode;
 *          bits 0-2 border colour
 *
 * The text area is `columns` characters of 8 pixels from the horizontal
 * origin and `rows` character rows (8 or 16 lines each) from the vertical
 * origin; everything else is border. For each character the VIC reads the
 * screen byte and the colour nybble beside it, then the character's pattern
 * byte for the line. A colour with bit 3 clear is high resolution (a set bit
 * is the character colour, a clear one the background; reverse mode swaps
 * them); with bit 3 set the pattern is four double-width pixels, each 00
 * background, 01 border, 10 character colour, 11 auxiliary colour.
 *
 * The picture is drawn lazily, cycle by cycle, up to the time the machine
 * asks for (before each register write and at frame end), so a register
 * changed in the middle of a line takes effect from where the beam is. The
 * VIC fetches on the half of the cycle the CPU does not use, so it never
 * holds the CPU up. The chip's own pipeline delays between a fetch and the
 * pixels it makes are not modelled: a character's pixels come out on the two
 * cycles it is fetched in.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { VIC20_PIXEL_DOUBLE, type Vic20Timing } from './constants.ts';
import type { Vic20Memory } from './memory.ts';
import { VIC20_PALETTE } from './palette.ts';

export class Vic {
  readonly regs = new Uint8Array(16);
  /** The visible window, RGBA, each VIC pixel two buffer pixels wide. */
  readonly pixels: Uint32Array;
  readonly width: number;
  readonly height: number;
  /** The last byte the VIC read: what the CPU finds on an empty part of the bus. */
  busValue = 0xFF;
  /** Paddle positions the POT registers read (0-255). */
  potX = 0xFF;
  potY = 0xFF;

  /** CPU cycle the frame being drawn started at, and how far it is drawn. */
  private frameStart = 0;
  private drawn = 0;

  // Per-frame vertical state.
  private textStarted = false;
  private textDone = false;
  private row = 0;
  private lineInRow = 0;
  /** The line being drawn is part of the text area. */
  private textLine = false;
  // The character being drawn: its pattern and colour nybble.
  private pattern = 0;
  private colour = 0;

  constructor(private readonly mem: Vic20Memory, private readonly timing: Vic20Timing) {
    this.width = timing.visiblePixels * VIC20_PIXEL_DOUBLE;
    this.height = timing.visibleLines;
    this.pixels = new Uint32Array(this.width * this.height);
    this.reset();
  }

  reset(): void {
    this.regs.fill(0);
    this.busValue = 0xFF;
    this.pixels.fill(VIC20_PALETTE[0]);
    this.beginFrame(this.frameStart);
  }

  /** Start drawing a frame that begins at CPU cycle `t`. */
  beginFrame(t: number): void {
    this.frameStart = t;
    this.drawn = t;
    this.textStarted = false;
    this.textDone = false;
    this.textLine = false;
    this.row = 0;
    this.lineInRow = 0;
  }

  /** The raster line at CPU cycle `t` (lines of the frame being drawn; time
   *  past its end is in the next frame). */
  rasterAt(t: number): number {
    const tm = this.timing;
    const into = t - this.frameStart;
    const inFrame = ((into % tm.cyclesPerFrame) + tm.cyclesPerFrame) % tm.cyclesPerFrame;
    return Math.floor(inFrame / tm.cyclesPerLine);
  }

  /** Read register `reg` (0-15) at CPU cycle `t`. */
  read(reg: number, t: number): number {
    reg &= 0x0F;
    switch (reg) {
      case 3: return (this.regs[3] & 0x7F) | ((this.rasterAt(t) & 1) << 7);
      case 4: return (this.rasterAt(t) >> 1) & 0xFF;
      case 8: return this.potX;
      case 9: return this.potY;
      default: return this.regs[reg];
    }
  }

  /** The register as the debugger sees it (the same: reads have no side effects). */
  peek(reg: number, t: number): number { return this.read(reg, t); }

  /** Write register `reg` at CPU cycle `t`: the picture is drawn up to then first. */
  write(reg: number, value: number, t: number): void {
    reg &= 0x0F;
    this.drawTo(t);
    // The raster and the light pen and paddle latches are the chip's own.
    if (reg === 4 || reg === 6 || reg === 7 || reg === 8 || reg === 9) return;
    this.regs[reg] = value & 0xFF;
  }

  /** Draw the frame up to CPU cycle `t` (at most to its end). */
  drawTo(t: number): void {
    const tm = this.timing;
    const end = Math.min(t, this.frameStart + tm.cyclesPerFrame);
    const cpl = tm.cyclesPerLine;
    while (this.drawn < end) {
      const c = this.drawn - this.frameStart;
      const line = Math.floor(c / cpl);
      const cycle = c - line * cpl;
      if (cycle === 0) this.startLine(line);
      this.drawCycle(line, cycle);
      this.drawn++;
    }
  }

  /** The vertical side of the text area, once at the start of each line. */
  private startLine(line: number): void {
    const regs = this.regs;
    const height = (regs[3] & 1) !== 0 ? 16 : 8;
    const rows = (regs[3] >> 1) & 0x3F;
    if (this.textLine) {
      // Moving on from a line of text.
      if (++this.lineInRow >= height) {
        this.lineInRow = 0;
        this.row++;
      }
      if (this.row >= rows) { this.textDone = true; }
    }
    if (!this.textStarted && (line >> 1) === regs[1]) {
      this.textStarted = true;
      this.row = 0;
      this.lineInRow = 0;
    }
    this.textLine = this.textStarted && !this.textDone && this.row < rows;
  }

  /** The four pixels of one cycle of line `line`. */
  private drawCycle(line: number, cycle: number): void {
    const tm = this.timing;
    const y = line - tm.firstLine;
    const x0 = cycle * 4 - tm.firstPixel;
    const visible = y >= 0 && y < this.height && x0 > -4 && x0 < tm.visiblePixels;

    const regs = this.regs;
    const border = regs[15] & 7;
    let inText = false;
    let half = 0;
    if (this.textLine) {
      const hOrigin = regs[0] & 0x7F;
      const columns = regs[2] & 0x7F;
      const into = cycle - hOrigin;
      if (into >= 0 && into < columns * 2) {
        inText = true;
        half = into & 1;
        if (half === 0) this.fetch(into >> 1, columns);
      }
    }
    if (!visible) return;

    const px = this.pixels;
    const rowBase = y * this.width;
    if (!inText) {
      const colour = VIC20_PALETTE[border];
      for (let i = 0; i < 4; i++) this.put(px, rowBase, x0 + i, colour);
      return;
    }
    const bg = regs[15] >> 4;
    // The pattern's four bits this cycle shows: the high half first.
    const bits = half === 0 ? this.pattern >> 4 : this.pattern & 0x0F;
    const cc = this.colour;
    if ((cc & 8) === 0) {
      const reverse = (regs[15] & 8) === 0;
      const on = VIC20_PALETTE[reverse ? bg : cc & 7];
      const off = VIC20_PALETTE[reverse ? cc & 7 : bg];
      for (let i = 0; i < 4; i++) this.put(px, rowBase, x0 + i, (bits & (8 >> i)) !== 0 ? on : off);
    } else {
      const aux = regs[14] >> 4;
      for (let i = 0; i < 4; i += 2) {
        const pair = (bits >> (2 - i)) & 3;
        const idx = pair === 0 ? bg : pair === 1 ? border : pair === 2 ? cc & 7 : aux;
        const colour = VIC20_PALETTE[idx];
        this.put(px, rowBase, x0 + i, colour);
        this.put(px, rowBase, x0 + i + 1, colour);
      }
    }
  }

  /** One VIC pixel at visible x `x`, two buffer pixels wide. */
  private put(px: Uint32Array, rowBase: number, x: number, colour: number): void {
    if (x < 0 || x >= this.timing.visiblePixels) return;
    const at = rowBase + x * VIC20_PIXEL_DOUBLE;
    px[at] = colour;
    px[at + 1] = colour;
  }

  /** The VIC address of the screen (video matrix). */
  get screenAddress(): number {
    return ((this.regs[5] & 0xF0) << 6) | ((this.regs[2] & 0x80) << 2);
  }

  /** The VIC address of the character patterns. */
  get charAddress(): number { return (this.regs[5] & 0x0F) << 10; }

  /** Read the screen byte, colour and pattern of column `col` on this line. */
  private fetch(col: number, columns: number): void {
    const mem = this.mem;
    const cell = (this.screenAddress + this.row * columns + col) & 0x3FFF;
    const code = mem.vicRead(cell);
    this.colour = mem.vicColour(cell);
    const tall = (this.regs[3] & 1) !== 0;
    const addr = (this.charAddress + (tall ? code * 16 : code * 8) + this.lineInRow) & 0x3FFF;
    this.pattern = mem.vicRead(addr);
    this.busValue = this.pattern;
  }

  saveState(w: StateWriter): void {
    w.raw(this.regs);
    w.u8(this.busValue);
    w.bool(this.textStarted); w.bool(this.textDone); w.bool(this.textLine);
    w.u8(this.row); w.u8(this.lineInRow);
  }

  /** Restore the registers and the frame's vertical state. The picture is
   *  drawn again from the start of the next frame (`beginFrame`). */
  loadState(r: StateReader): void {
    r.rawInto(this.regs);
    this.busValue = r.u8();
    this.textStarted = r.bool(); this.textDone = r.bool(); this.textLine = r.bool();
    this.row = r.u8(); this.lineInRow = r.u8();
  }
}
