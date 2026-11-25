/**
 * The MOS 7360 "TED" (Text Editing Device): the Commodore Plus/4's and C16's
 * video and sound chip, and the machine's bus master.
 *
 * The 64 registers at `$FF00`:
 *
 *   $00-$05  three timers, low byte then high (this file keeps the pairs high
 *            first in the latch, as the chip latches them); each counts at
 *            half the CPU clock
 *   $06      CR1: TEST, ECM, BMM, DEN, RSEL (24/25 rows), YSCROLL
 *   $07      CR2: REVERSE, PAL/NTSC, STOP, MCM, CSEL (38/40 columns), XSCROLL
 *   $08      keyboard: which matrix rows are enabled, and the joystick gates
 *   $09      interrupt status: raster, timer 1/2/3, light pen, and bit 7 "any"
 *   $0A      interrupt mask, plus bit 8 of the raster compare line
 *   $0B      read: the raster counter; write: the raster compare line
 *   $0C-$0D  cursor position
 *   $0E-$12  sound: voice 1 and 2 frequency, the control register, the bitmap
 *            base
 *   $13      character base, 1 MHz mode, video ROM select
 *   $14      video matrix / colour base
 *   $15-$19  background, colour 1-3, extended background
 *   $1A-$1B  bitmap reload
 *   $1C-$1E  vertical and horizontal scan position (read only)
 *   $1F      blink counter and vertical character position
 *   $3E/$3F  write: the ROM is visible over `$8000-$FFFF` / the RAM is
 *
 * Unused register bits read back as 1 (the chip's own table, `UNUSED_BITS`).
 *
 * The picture is drawn one raster line at a time: a register written mid-line
 * takes effect from the next line. That serves the KERNAL, BASIC 3.5 and the
 * display splits between lines; it is coarser than the chip for mid-line
 * tricks, which is this model's one knowing approximation.
 *
 * A bad line — the line of a character row whose line counter matches YSCROLL —
 * is the line the chip fetches the whole 40-character row on, and it holds the
 * CPU off the bus (the machine charges 88 of the 114 cycles). That is what
 * makes the raster compare interrupt and the splits usable.
 *
 * The frame buffer is the 320x200 display window with 16 lines of the chip's
 * overscan border above and below it (and 32 pixels either side): the whole
 * picture a TV shows, cropped a little at the blanking.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import {
  PLUS4_BORDER_LEFT, PLUS4_BORDER_TOP, PLUS4_COLUMNS, PLUS4_FRAME_HEIGHT, PLUS4_FRAME_WIDTH,
  plus4Timing, type Plus4Timing,
} from './constants.ts';
import { PLUS4_PALETTE } from './palette.ts';

/** A read of a register ORs in its unused bits, which always read 1. */
const UNUSED_BITS: readonly number[] = [
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0xA0, 0x00, 0xFC, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x07, 0x80, 0x80, 0x80,
  0x80, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF,
];

/** Interrupt status/mask bits. */
export const TED_IRQ_RASTER = 0x02;
export const TED_IRQ_LIGHT_PEN = 0x04;
export const TED_IRQ_TIMER1 = 0x08;
export const TED_IRQ_TIMER2 = 0x10;
export const TED_IRQ_TIMER3 = 0x40;
export const TED_IRQ_ANY = 0x80;


/** The TED takes the bus for 43 characters + 3 fetches, doubled, on a bad
 *  line: 88 of its 114 cycles. */
const BAD_LINE_HOLD = 88;
/** The TED's 40-column window begins on this cycle of the line; a character
 *  takes two cycles, so a cycle is four pixels of the display. */
const DISPLAY_START_CYCLE = 15;
/** Registers whose value can change the picture part-way through a line. */
const DISPLAY_REGS: ReadonlySet<number> = new Set([
  0x06, 0x07, 0x0C, 0x0D, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x3E, 0x3F,
]);

/** What the chip needs of the machine it is on. */
export interface TedBus {
  /** A byte of the CPU's address space, RAM or a banked ROM (video fetches see
   *  the same map the CPU does). */
  read(addr: number): number;
  /** The eight column lines the TED reads back: a bit clear is a key down, on
   *  whichever of PIO 2's lines are selected. */
  keyboardColumns(): number;
  /** Joystick directions and fire for the two control ports, as the register
   *  reports them: bit 0 up, 1 down, 2 left, 3 right, 4 fire. */
  joystickBits(): { readonly joy1: number; readonly joy2: number };
}

/** One of the chip's three timers. */
class TedTimer {
  /** The 16-bit value the counter reloads from. */
  latch = 0;
  /** CPU cycles left before it fires (it counts one per two CPU cycles). */
  remaining = 0;
  running = false;

  reset(): void { this.latch = 0; this.remaining = 0; this.running = false; }

  /** A latch of 0 counts a whole 65536. */
  get period(): number { return (this.latch === 0 ? 0x10000 : this.latch) * 2; }

  start(): void { this.remaining = this.period; this.running = true; }
}

export class Ted {
  readonly regs = new Uint8Array(64);
  readonly timing: Plus4Timing;

  /** The visible window, RGBA. */
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint32Array;
  /** Where the 320x200 display window starts in the buffer. */
  readonly fieldX: number;
  readonly fieldY: number;

  /** The last byte the chip left on the bus (an empty place reads it). */
  busValue = 0xFF;

  /** The raster counter, 0 to `linesPerFrame - 1`. */
  raster = 0;
  /** The raster compare line (9 bits, so it can name a line past the frame). */
  rasterIrqLine = 0;

  readonly timers = [new TedTimer(), new TedTimer(), new TedTimer()];
  irqStatus = 0;
  irqMask = 0;

  /** Cursor position, and the flash phase the chip advances each frame. */
  cursorPos = 0;
  cursorPhase = 0;
  cursorVisible = false;

  /** The keyboard write (`$FF08`): the joystick gates are its bits 2 and 3. */
  keyboardLatch = 0xFF;
  /** The value the keyboard register returned, as the debugger reads it. */
  keyboardValue = 0xFF;

  /** CPU cycle the timers have been run to. */
  private now = 0;
  /** CPU cycle the frame being drawn started at, and how far it is drawn. */
  private frameStart = 0;
  private drawn = 0;
  /** The cycle the line being painted started at, and how far it is painted. */
  private lineStartT = 0;
  private linePaintT = 0;

  /** The 40 screen bytes and their colour bytes of the row last fetched. */
  private readonly vbuf = new Uint8Array(PLUS4_COLUMNS);
  private readonly cbuf = new Uint8Array(PLUS4_COLUMNS);
  private rowFetched = -1;
  /** Whether this line is a bad line (the chip fetches its row and holds the bus). */
  private badLine = false;

  constructor(private readonly bus: TedBus, ntsc: boolean) {
    this.timing = plus4Timing(ntsc);
    this.width = PLUS4_FRAME_WIDTH;
    this.height = PLUS4_FRAME_HEIGHT;
    this.pixels = new Uint32Array(this.width * this.height);
    this.fieldX = PLUS4_BORDER_LEFT;
    this.fieldY = PLUS4_BORDER_TOP;
    this.reset();
  }

  reset(): void {
    this.regs.fill(0);
    this.busValue = 0xFF;
    this.raster = 0;
    this.rasterIrqLine = 0;
    this.timers.forEach(t => t.reset());
    this.irqStatus = 0;
    this.irqMask = 0;
    this.cursorPos = 0;
    this.cursorPhase = 0;
    this.cursorVisible = false;
    this.keyboardLatch = 0xFF;
    this.keyboardValue = 0xFF;
    this.now = 0;
    this.frameStart = 0;
    this.drawn = 0;
    this.rowFetched = -1;
    this.badLine = false;
    this.pixels.fill(PLUS4_PALETTE[0]);
  }

  // ── Registers ────────────────────────────────────────────────────────────

  /** The raster compare line: `$FF0B` and bit 0 of `$FF0A` as its bit 8. */
  get compareLine(): number { return (this.regs[0x0B] | ((this.regs[0x0A] & 0x01) << 8)) & 0x1FF; }

  /** Read register `reg` at CPU cycle `t`. */
  read(reg: number, t: number): number {
    reg &= 0x3F;
    this.advanceTo(t);
    switch (reg) {
      case 0x00: return this.timers[0].remaining >> 1 & 0xFF;
      case 0x01: return (this.timers[0].remaining >> 9) & 0xFF;
      case 0x02: return this.timers[1].remaining >> 1 & 0xFF;
      case 0x03: return (this.timers[1].remaining >> 9) & 0xFF;
      case 0x04: return this.timers[2].remaining >> 1 & 0xFF;
      case 0x05: return (this.timers[2].remaining >> 9) & 0xFF;
      case 0x08: {
        this.keyboardValue = this.keyboardByte();
        return this.keyboardValue;
      }
      case 0x09: return this.irqStatus & 0xFF;
      case 0x0A: return this.irqMask | UNUSED_BITS[0x0A];
      case 0x0C: return ((this.cursorPos >> 8) & 3) | UNUSED_BITS[0x0C];
      case 0x1C: return (this.raster >> 8) & 1;
      case 0x1D: return this.raster & 0xFF;
      case 0x1E: return 0;
      case 0x1F: return (this.subLine() & 7) | ((this.cursorPhase & 0x0F) << 3);
      default: return this.regs[reg] | UNUSED_BITS[reg];
    }
  }

  /** The register as the debugger sees it (reads have no other side effect). */
  peek(reg: number, t: number): number { return this.read(reg, t); }

  /** Write register `reg` at CPU cycle `t`. */
  write(reg: number, value: number, t: number): void {
    reg &= 0x3F;
    const v = value & 0xFF;
    this.advanceTo(t);
    if (DISPLAY_REGS.has(reg)) {
      // A picture register written part-way through a line changes the display
      // from the cycle it lands on: catch the beam up, and paint what it has
      // passed with the values it passed it with, before they change.
      this.drawTo(t);
      this.paintLineTo(t);
    }
    switch (reg) {
      case 0x00: this.timers[0].latch = (this.timers[0].latch & 0xFF00) | v; this.timers[0].running = false; break;
      case 0x01: this.timers[0].latch = (this.timers[0].latch & 0x00FF) | (v << 8); this.timers[0].start(); break;
      case 0x02: this.timers[1].latch = (this.timers[1].latch & 0xFF00) | v; this.timers[1].running = false; break;
      case 0x03: this.timers[1].latch = (this.timers[1].latch & 0x00FF) | (v << 8); this.timers[1].start(); break;
      case 0x04: this.timers[2].latch = (this.timers[2].latch & 0xFF00) | v; this.timers[2].running = false; break;
      case 0x05: this.timers[2].latch = (this.timers[2].latch & 0x00FF) | (v << 8); this.timers[2].start(); break;
      case 0x06: this.regs[reg] = v & 0x7F; break;
      case 0x07: this.regs[reg] = v; break;
      case 0x08: this.keyboardLatch = v; break;
      case 0x09:
        // A write acknowledges: bit 7 clears every flagged source, else the
        // sources whose bits are written.
        this.irqStatus = (v & TED_IRQ_ANY) !== 0 ? 0 : this.irqStatus & ~(v & 0x5E);
        this.updateIrqLine();
        break;
      // Bit 0 is the raster compare line's bit 8 (not a mask bit), and bit 5 is
      // unused: the mask register keeps bits 1-6 whatever else is written.
      case 0x0A: this.irqMask = v; this.updateIrqLine(); break;
      case 0x0B: this.regs[reg] = v; this.rasterIrqLine = this.compareLine; break;
      case 0x0C: this.cursorPos = (this.cursorPos & 0xFF) | ((v & 3) << 8); this.regs[reg] = v; break;
      case 0x0D: this.cursorPos = (this.cursorPos & 0x300) | v; this.regs[reg] = v; break;
      case 0x0E: case 0x0F: case 0x11:
        this.regs[reg] = v; break;
      case 0x10: this.regs[reg] = v & 0x03; break;
      case 0x12: this.regs[reg] = v & 0x7F; break;
      case 0x13: this.regs[reg] = v; break;
      case 0x14: this.regs[reg] = v & 0xF8; break;
      case 0x15: case 0x16: case 0x17: case 0x18: case 0x19: this.regs[reg] = v & 0x7F; break;
      case 0x1A: case 0x1B: case 0x1F: this.regs[reg] = v; break;
      case 0x3E: this.regs[0x13] |= 0x01; break;    // ROM visible
      case 0x3F: this.regs[0x13] &= 0xFE; break;    // RAM visible
      default: break;                                // read-only, or unused
    }
  }

  /** The eight column lines from the rows the PIO selects and the joystick gates. */
  private keyboardByte(): number {
    let val = this.bus.keyboardColumns();
    const joy = this.bus.joystickBits();
    if ((this.keyboardLatch & 0x04) === 0) {
      val &= ~(joy.joy1 & 0x0F);
      if ((joy.joy1 & 0x10) !== 0) val &= ~0x40;
    }
    if ((this.keyboardLatch & 0x02) === 0) {
      val &= ~(joy.joy2 & 0x0F);
      if ((joy.joy2 & 0x10) !== 0) val &= ~0x80;
    }
    return val & 0xFF;
  }

  /** The TED's `$FF08` read: the column lines of the rows the PIO selects. */
  refreshKeyboard(): void { this.keyboardValue = this.keyboardByte(); }

  // ── Display geometry ────────────────────────────────────────────────────

  /** The 25-row display's first line, or the 24-row mode's. */
  get displayStart(): number { return (this.regs[0x06] & 0x08) !== 0 ? 4 : 8; }
  /** One past its last line. */
  get displayStop(): number { return (this.regs[0x06] & 0x08) !== 0 ? 0xCC : 0xC8; }
  /** The YSCROLL register. */
  get yscroll(): number { return this.regs[0x06] & 0x07; }
  /** The XSCROLL register. */
  get xscroll(): number { return this.regs[0x07] & 0x07; }
  /** Whether the display is enabled (DEN). */
  get displayOn(): boolean { return (this.regs[0x06] & 0x10) !== 0; }
  /** Whether reverse video is on (`$FF07` bit 7). */
  get reverseMode(): boolean { return (this.regs[0x07] & 0x80) !== 0; }
  /** Whether the display is 38 columns rather than 40. */
  get narrow(): boolean { return (this.regs[0x07] & 0x08) === 0; }

  /** The video mode the mode bits select. */
  get videoMode(): number { return ((this.regs[0x06] & 0x60) | (this.regs[0x07] & 0x10)) >> 4; }
  /** Whether the mode has a bitmap. */
  get bitmapMode(): boolean { return (this.videoMode & 0x02) !== 0; }
  /** Whether the mode is one of the illegal ones the chip paints black. */
  get illegalMode(): boolean { return this.videoMode >= 5; }
  /** Extended background colours on (ECM). */
  get ecm(): boolean { return (this.regs[0x06] & 0x40) !== 0; }

  /** The video matrix address (`$FF14` bits 3-7, plus the chip's `$400` bias). */
  get screenAddress(): number { return ((this.regs[0x14] & 0xF8) << 8) | 0x400; }
  /** The colour RAM base: the matrix's base without the `$400` bias. */
  get colourAddress(): number { return (this.regs[0x14] & 0xF8) << 8; }
  /** The character pattern base (`$FF13` bits 2-7, 1K steps). */
  get charAddress(): number { return (this.regs[0x13] & 0xFC) << 8; }
  /** The bitmap base (`$FF12` bits 3-5, 2K steps). */
  get bitmapAddress(): number { return (this.regs[0x12] & 0x38) << 10; }

  /** The background colour (`$FF15`). */
  get background(): number { return this.regs[0x15] & 0x7F; }
  /** Extended background colour `i` (0-2) from `$FF16`-`$FF18`. */
  extendedBackground(i: number): number { return this.regs[0x16 + i] & 0x7F; }

  /** The character row `line` is in, and the line within it. */
  rowOf(line: number): { row: number; sub: number } {
    const off = Math.max(0, line - this.displayStart);
    return { row: off >> 3, sub: off & 7 };
  }

  /** Whether `line` is a bad line: the chip fetches its row and holds the bus. */
  isBadLine(line: number): boolean {
    if (!this.displayOn || this.illegalMode) return false;
    if (line < this.displayStart || line >= this.displayStop) return false;
    return this.rowOf(line).sub === this.yscroll;
  }

  /** The line within the character row `line` is on, after the scroll. */
  private subLine(): number {
    const { sub } = this.rowOf(this.raster);
    return (sub - this.yscroll) & 7;
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  /** Start drawing a frame that begins at CPU cycle `t`. */
  beginFrame(t: number): void {
    this.frameStart = t;
    this.drawn = t;
    this.lineStartT = t;
    this.linePaintT = t;
    this.rowFetched = -1;
  }

  /** Bring the chip's clock to `t` (after a reset or a restore). */
  syncClocks(t: number): void { this.now = t; this.beginFrame(t); }

  /** The raster line at CPU cycle `t` (of the frame being drawn). */
  rasterAt(t: number): number {
    const tm = this.timing;
    const into = ((t - this.frameStart) % tm.cyclesPerFrame + tm.cyclesPerFrame) % tm.cyclesPerFrame;
    return Math.floor(into / tm.cyclesPerLine);
  }

  /** Draw the frame up to CPU cycle `t` (at most to its end), stepping the
   *  raster a line at a time. Returns the cycle the CPU's bus is free from (a
   *  bad line holds it for 88 of its 114 cycles), or 0 when it is free now. */
  drawTo(t: number): number {
    const tm = this.timing;
    const end = Math.min(t, this.frameStart + tm.cyclesPerFrame);
    let free = 0;
    while (this.drawn < end) {
      const into = this.drawn - this.frameStart;
      if (into % tm.cyclesPerLine === 0) {
        this.startLine();
        if (this.badLine) free = this.frameStart + into + BAD_LINE_HOLD;
      }
      this.drawn++;
      if ((this.drawn - this.frameStart) % tm.cyclesPerLine === 0) this.endLine();
    }
    return free;
  }

  /** The start of a raster line: the compare interrupt, then the fetch. */
  startLine(): void {
    const line = this.raster;
    this.lineStartT = this.drawn;
    this.linePaintT = this.drawn;
    const { row } = this.rowOf(line);
    this.badLine = this.isBadLine(line);
    if (this.badLine || this.rowFetched !== row) {
      if (this.displayOn && !this.illegalMode && line >= this.displayStart && line < this.displayStop) {
        this.fetchRow(row);
      }
    }
    if ((this.irqMask & TED_IRQ_RASTER) !== 0 && line === this.rasterIrqLine) {
      this.irqStatus |= TED_IRQ_RASTER;
      this.updateIrqLine();
    }
  }

  /** The end of a raster line: finish painting it and step the raster counter. */
  endLine(): void {
    this.paintLineTo(this.drawn);
    this.raster++;
    if (this.raster >= this.timing.linesPerFrame) {
      this.raster = 0;
      this.rowFetched = -1;
      this.cursorPhase = (this.cursorPhase + 1) & 0x1F;
      this.cursorVisible = (this.cursorPhase & 0x10) !== 0;
    }
  }

  /** Fetch row `row`'s 40 screen bytes and colour bytes. */
  private fetchRow(row: number): void {
    if (row === this.rowFetched) return;
    this.rowFetched = row;
    const matrix = this.screenAddress + row * PLUS4_COLUMNS;
    const colour = this.colourAddress + row * PLUS4_COLUMNS;
    for (let i = 0; i < PLUS4_COLUMNS; i++) {
      this.vbuf[i] = this.bus.read((matrix + i) & 0xFFFF);
      this.cbuf[i] = this.bus.read((colour + i) & 0xFFFF);
    }
    this.busValue = this.vbuf[PLUS4_COLUMNS - 1];
  }

  /** Where the beam is in the row buffer at cycle `t` of the current line. */
  private pixelForCycle(t: number): number {
    const x = this.fieldX + (this.narrow ? 7 : 0) + this.xscroll
      + (Math.floor(t - this.lineStartT) - DISPLAY_START_CYCLE) * 4;
    return x < 0 ? 0 : x > this.width ? this.width : x;
  }

  /**
   * Paint the current raster line from where it was left up to cycle `t` of
   * the frame. Called at every line end, and when a display register is
   * written part-way through a line, so the beam paints with the values that
   * were in the register at the time it passed.
   */
  private paintLineTo(t: number): void {
    if (t <= this.linePaintT) return;
    const from = this.pixelForCycle(this.linePaintT);
    const to = this.pixelForCycle(t);
    this.linePaintT = t;
    const y = this.raster + this.timing.rasterOffset;
    if (y < 0 || y >= this.height || to <= from) return;
    const rowBase = y * this.width;
    const px = this.pixels;
    // The border and the paper behind the display are the background colour.
    px.fill(PLUS4_PALETTE[this.background], rowBase + from, rowBase + to);
    if (!this.displayOn || this.illegalMode) return;
    if (this.raster < this.displayStart || this.raster >= this.displayStop) return;
    const { sub } = this.rowOf(this.raster);
    const rowLine = (sub - this.yscroll) & 7;
    const x0 = this.fieldX + (this.narrow ? 7 : 0) + this.xscroll;
    switch (this.videoMode) {
      case 0: this.drawText(px, rowBase, x0, rowLine, false, false, from, to); break;
      case 1: this.drawText(px, rowBase, x0, rowLine, true, false, from, to); break;
      case 2: this.drawBitmap(px, rowBase, x0, rowLine, false, from, to); break;
      case 3: this.drawBitmap(px, rowBase, x0, rowLine, true, from, to); break;
      case 4: this.drawText(px, rowBase, x0, rowLine, false, true, from, to); break;
      default: break;
    }
  }

  /** Paint pixels `from`..`to` of one cell, clipped to the row. */
  private plot(px: Uint32Array, rowBase: number, at: number, colour: number, from: number, to: number): void {
    if (at < from || at >= to || at >= this.width) return;
    px[rowBase + at] = colour;
  }

  /** Standard, multicolour and extended text modes, from `from` to `to`. */
  private drawText(
    px: Uint32Array, rowBase: number, x0: number, rowLine: number,
    multicolour: boolean, extended: boolean, from: number, to: number,
  ): void {
    const reverseMode = this.reverseMode;
    const background = PLUS4_PALETTE[this.background];
    for (let col = 0; col < PLUS4_COLUMNS; col++) {
      const cellX = x0 + col * 8;
      if (cellX + 8 <= from || cellX >= to) continue;
      const raw = this.vbuf[col];
      const attr = this.cbuf[col] & 0x7F;
      const code = raw & (reverseMode ? 0xFF : 0x7F);
      const glyphAddr = (this.charAddress + (code & 0x7F) * 8 + rowLine) & 0xFFFF;
      let bits = this.bus.read(glyphAddr) & 0xFF;
      if (!reverseMode && (raw & 0x80) !== 0) bits ^= 0xFF;

      if (multicolour && (attr & 0x08) !== 0) {
        // Four double-width pixels: 00 background, 01 colour 1, 10 colour 2,
        // 11 the cell's own colour.
        const colours = [
          this.background, this.regs[0x17] & 0x7F, this.regs[0x18] & 0x7F, attr & 0x77,
        ];
        for (let pair = 0; pair < 4; pair++) {
          const colour = PLUS4_PALETTE[colours[(bits >> (6 - pair * 2)) & 3] & 0x7F];
          this.plot(px, rowBase, cellX + pair * 2, colour, from, to);
          this.plot(px, rowBase, cellX + pair * 2 + 1, colour, from, to);
        }
        continue;
      }
      const ink = PLUS4_PALETTE[attr];
      const paper = extended ? PLUS4_PALETTE[this.extendedBackground((raw >> 6) & 3)] : background;
      for (let bit = 0; bit < 8; bit++) {
        this.plot(px, rowBase, cellX + bit, (bits & (0x80 >> bit)) !== 0 ? ink : paper, from, to);
      }
    }
  }

  /** Hires and multicolour bitmap modes, from `from` to `to`. */
  private drawBitmap(
    px: Uint32Array, rowBase: number, x0: number, rowLine: number, multicolour: boolean,
    from: number, to: number,
  ): void {
    const base = this.bitmapAddress;
    const { row } = this.rowOf(this.raster);
    const rowOffset = (row * 8 + rowLine) * PLUS4_COLUMNS;
    for (let col = 0; col < PLUS4_COLUMNS; col++) {
      const cellX = x0 + col * 8;
      if (cellX + 8 <= from || cellX >= to) continue;
      const bits = this.bus.read((base + rowOffset + col) & 0xFFFF) & 0xFF;
      if (multicolour) {
        const attr = this.cbuf[col];
        const colours = [
          this.background,
          (this.vbuf[col] >> 4) | ((attr & 0x07) << 4),
          (this.vbuf[col] & 0x0F) | (attr & 0x70),
          this.regs[0x16] & 0x7F,
        ];
        for (let pair = 0; pair < 4; pair++) {
          const colour = PLUS4_PALETTE[colours[(bits >> (6 - pair * 2)) & 3] & 0x7F];
          this.plot(px, rowBase, cellX + pair * 2, colour, from, to);
          this.plot(px, rowBase, cellX + pair * 2 + 1, colour, from, to);
        }
        continue;
      }
      const ink = PLUS4_PALETTE[this.cbuf[col] & 0x7F];
      const paper = PLUS4_PALETTE[this.background];
      for (let bit = 0; bit < 8; bit++) {
        this.plot(px, rowBase, cellX + bit, (bits & (0x80 >> bit)) !== 0 ? ink : paper, from, to);
      }
    }
  }

  // ── Timers and interrupts ───────────────────────────────────────────────

  /** The interrupt mask's source bits (bit 0 is the compare line's bit 8). */
  private get maskBits(): number { return this.irqMask & 0x5E; }

  /** The IRQ line the machine raises: an enabled flagged source. */
  get irq(): boolean { return (this.irqStatus & this.maskBits) !== 0; }

  private updateIrqLine(): void {
    if ((this.irqStatus & this.maskBits) !== 0) this.irqStatus |= TED_IRQ_ANY;
    else this.irqStatus &= ~TED_IRQ_ANY;
  }

  /** Run the timers to CPU cycle `t`. */
  advanceTo(t: number): void {
    const dt = Math.floor(t - this.now);
    if (dt <= 0) return;
    this.now = t;
    for (let i = 0; i < 3; i++) {
      const timer = this.timers[i];
      if (!timer.running) continue;
      timer.remaining -= dt;
      while (timer.remaining <= 0) {
        timer.remaining += timer.period;
        this.irqStatus |= i === 0 ? TED_IRQ_TIMER1 : i === 1 ? TED_IRQ_TIMER2 : TED_IRQ_TIMER3;
      }
    }
    this.updateIrqLine();
  }

  // ── Snapshots ───────────────────────────────────────────────────────────

  saveState(w: StateWriter): void {
    w.raw(this.regs);
    w.f64(this.now); w.u16(this.raster); w.u16(this.rasterIrqLine);
    w.u8(this.irqStatus); w.u8(this.irqMask);
    w.u16(this.cursorPos); w.u8(this.cursorPhase); w.bool(this.cursorVisible);
    w.u8(this.keyboardLatch); w.u8(this.keyboardValue); w.u8(this.busValue);
    for (const t of this.timers) { w.u16(t.latch); w.f64(t.remaining); w.bool(t.running); }
  }

  loadState(r: StateReader): void {
    r.rawInto(this.regs);
    this.now = r.f64(); this.raster = r.u16(); this.rasterIrqLine = r.u16();
    this.irqStatus = r.u8(); this.irqMask = r.u8();
    this.cursorPos = r.u16(); this.cursorPhase = r.u8(); this.cursorVisible = r.bool();
    this.keyboardLatch = r.u8(); this.keyboardValue = r.u8(); this.busValue = r.u8();
    for (const t of this.timers) { t.latch = r.u16(); t.remaining = r.f64(); t.running = r.bool(); }
    this.beginFrame(this.now);
  }
}
