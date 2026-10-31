/**
 * PcwAsic — the PCW's custom gate array.
 *
 * This is the machine's only piece of custom silicon, and it does four jobs
 * that on other machines belong to four different chips:
 *
 *   1. **Video.** A 720x256 monochrome bitmap fetched through *roller RAM* —
 *      a 256-entry table in main memory, one entry per scan line, each giving
 *      the physical address that line's pixels start at.
 *   2. **The 300Hz timer**, one interrupt every 52 scan lines, plus the counter
 *      of them that software reads back through port &F4 — which is also what
 *      holds /INT down.
 *   3. **The system status byte** read from &F4/&F8 (frame flyback, FDC
 *      interrupt, the 50/60Hz link, the counter).
 *   4. **Routing the uPD765A's interrupt** to /INT, /NMI or nowhere.
 *
 * Screen memory is stored as 8-byte character cells, so the 90 bytes of one
 * scan line are 8 apart in memory and the roller entry's low 3 bits pick the
 * pixel row within the cell. See `renderScanline`.
 */

import type { PcwMemory } from './pcw-memory.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import {
  PCW_BYTES_PER_LINE, PCW_DISPLAY_HEIGHT, PCW_DISPLAY_HEIGHT_60HZ, PCW_FLYBACK_LINES,
  PCW_GREEN_INK, PCW_GREEN_PAPER, PCW_INT_LINE_PHASE, PCW_INT_LINE_SPACING,
  PCW_LINE_BYTE_STRIDE, PCW_LINES_PER_FRAME, PCW_LINES_PER_FRAME_60HZ,
  PCW_ROLLER_BLOCK_SHIFT, PCW_ROLLER_OFFSET_MASK, PCW_ROLLER_OFFSET_UNIT,
  PCW_SCREEN_HEIGHT, PCW_SCREEN_WIDTH, PCW_STATUS_50HZ, PCW_STATUS_COUNT_MASK,
  PCW_STATUS_FDC_INT, PCW_STATUS_FLYBACK, PCW_VIDEO_ADDRESS_MASK, PCW_VIDEO_ENABLE,
  PCW_VIDEO_REVERSE, PCW_BORDER_LEFT, PCW_BORDER_TOP, pcwFlybackStart,
} from './constants.ts';

/** Raster geometry for one setting of the 50/60Hz link. */
export interface PcwFrameTiming {
  readonly hz: 50 | 60;
  readonly linesPerFrame: number;
  /** Lines shown, from line 0: 256 at 50Hz, 200 at 60Hz. */
  readonly displayHeight: number;
  /** First line of the 26-line frame flyback signal. */
  readonly flybackStart: number;
}

export const PCW_TIMING_50HZ: PcwFrameTiming = {
  hz: 50, linesPerFrame: PCW_LINES_PER_FRAME, displayHeight: PCW_DISPLAY_HEIGHT,
  flybackStart: pcwFlybackStart(PCW_LINES_PER_FRAME),
};
export const PCW_TIMING_60HZ: PcwFrameTiming = {
  hz: 60, linesPerFrame: PCW_LINES_PER_FRAME_60HZ, displayHeight: PCW_DISPLAY_HEIGHT_60HZ,
  flybackStart: pcwFlybackStart(PCW_LINES_PER_FRAME_60HZ),
};

/** Where a timer tick is on its way into the &F4 counter (see `PcwAsic.tickSync`). */
export const enum TickSync {
  None = 0,
  /** Raised; the next instruction fetch (M1) latches it. */
  Raised = 1,
  /** Latched by one M1; the next M1 counts it, unless the counter is read
   *  in between, which loses it. */
  Latched = 2,
}

/** Where the uPD765A's interrupt line is connected (port &F8 commands 2/3/4). */
export type FdcIntRoute = 'nmi' | 'int' | 'none';

/**
 * Physical address a roller RAM entry points at.
 *
 * The reference describes the *address* as "b16-14 control which bank the line
 * is to be found in, b13-3 the address in the bank (in 16-byte units), and
 * b2-0 the offset" — 17 bits, which plainly cannot be what a 16-bit entry
 * stores. Taking the "16-byte units" at its word resolves it exactly: the entry
 * holds the block in b15-13, the address within the block in 16-byte units in
 * b12-3, and the row offset in b2-0. That is 3 + 10 + 3 = 16 bits, and it
 * reduces to one shift with the low three bits passed through:
 *
 *     address = ((entry & 0xFFF8) << 1) | (entry & 7)
 *
 * which lines the fields up as documented: b15-13 become address b16-14, and
 * b12-3 become address b13-4 (hence "16-byte units").
 */
export function rollerEntryAddress(entry: number): number {
  return (((entry & 0xFFF8) << 1) | (entry & 7)) & PCW_VIDEO_ADDRESS_MASK;
}

export class PcwAsic {
  private readonly mem: PcwMemory;

  // ── Video registers ───────────────────────────────────────────────────────

  /** Port &F5: roller RAM base. b7-5 block, b4-0 offset in 512-byte units. */
  rollerBase = 0;
  /** Port &F6: the roller RAM entry the picture starts at. Scan line `n`
   *  reads entry (rollerOffset + n) & 255, wrapping within the 512-byte table
   *  (MAME pcw_v.cpp: roller_ram_offs = offset << 1, += 2, &= 511). This is
   *  how the PCW scrolls the whole screen — it does not shift the raster. */
  rollerOffset = 0;
  /** Port &F7: b6 screen enable, b7 reverse video. */
  videoCtl = PCW_VIDEO_ENABLE;
  /** Port &F8 commands 7/8 — screen on/off for external video. ANDed with the
   *  &F7 enable bit, so either one can blank the picture. */
  screenEnabled = true;

  /** Phosphor colours, swapped by the `pcw-phosphor` setting. */
  ink = PCW_GREEN_INK;
  paper = PCW_GREEN_PAPER;

  // ── Interrupt state ───────────────────────────────────────────────────────

  /** The 300Hz timer is pulsing /INT (for ~100us; the machine ends the pulse
   *  — see PCW_TIMER_PULSE_T). Taking the interrupt does not clear it. */
  timerPending = false;
  /** b3-0 of the status byte: timer interrupts since the counter was last read
   *  through port &F4. Saturates at 15 ("the counter will never increment
   *  beyond a count of fifteen"). */
  intCount = 0;
  /**
   * A tick's progress into the counter. "The counter is synchronized by two
   * CPU instruction fetch cycles (M1). If the M1 of a counter read command
   * latches a new pending timer interrupt, the counter will not at the time of
   * the read operation have been incremented, and therefore this new interrupt
   * will be lost." (spec §4). The machine advances it around each instruction
   * — see `syncTickBefore` / `syncTickAfter`.
   */
  tickSync: TickSync = TickSync.None;
  /** Where the FDC's interrupt goes. Nowhere until the BIOS routes it. */
  fdcRoute: FdcIntRoute = 'none';
  /** Live uPD765A interrupt line, refreshed by the machine each scan line. */
  fdcInt = false;

  /** The 50/60Hz link (a motherboard option): frame length, lines shown,
   *  where flyback falls and status b4. */
  timing: PcwFrameTiming = PCW_TIMING_50HZ;

  /** Current raster line, 0 to linesPerFrame-1. Line 0 is the first one
   *  displayed. */
  line = 0;

  constructor(mem: PcwMemory) {
    this.mem = mem;
  }

  reset(): void {
    this.rollerBase = 0;
    this.rollerOffset = 0;
    this.videoCtl = PCW_VIDEO_ENABLE;
    this.screenEnabled = true;
    this.timerPending = false;
    this.intCount = 0;
    this.tickSync = TickSync.None;
    this.fdcRoute = 'none';
    this.fdcInt = false;
    this.line = 0;
  }

  // ── Snapshot state ────────────────────────────────────────────────────────

  /** Video registers, the timer counter and a tick in flight, the FDC
   *  routing and line, and the raster line. The phosphor colours are a display
   *  setting and the 50/60Hz link is configuration (the machine's CONF). */
  saveState(w: StateWriter): void {
    w.u8(this.rollerBase); w.u8(this.rollerOffset); w.u8(this.videoCtl);
    w.bool(this.screenEnabled);
    w.bool(this.timerPending);
    w.u8(this.intCount);
    w.u8(this.fdcRoute === 'nmi' ? 0 : this.fdcRoute === 'int' ? 1 : 2);
    w.bool(this.fdcInt);
    w.u16(this.line);
    w.u8(this.tickSync);
  }

  loadState(r: StateReader): void {
    this.rollerBase = r.u8(); this.rollerOffset = r.u8(); this.videoCtl = r.u8();
    this.screenEnabled = r.bool();
    this.timerPending = r.bool();
    this.intCount = r.u8() & PCW_STATUS_COUNT_MASK;
    const route = r.u8();
    this.fdcRoute = route === 0 ? 'nmi' : route === 1 ? 'int' : 'none';
    this.fdcInt = r.bool();
    this.line = r.u16();
    // A state from before the counter drove /INT has no tick in flight.
    this.tickSync = r.remaining > 0 ? (r.u8() as TickSync) : TickSync.None;
  }

  // ── Timing ────────────────────────────────────────────────────────────────

  /**
   * True when a timer tick is raised at the *start* of `line`: 12 lines after
   * the top of the picture and every 52 after, at either frame rate (see
   * `PCW_INT_LINE_PHASE`). Six a field at 50Hz, five at 60Hz.
   */
  static isInterruptLine(line: number): boolean {
    return line % PCW_INT_LINE_SPACING === PCW_INT_LINE_PHASE;
  }

  /** Advance to `line`, raising a timer tick when one falls there. */
  beginLine(line: number): void {
    this.line = line;
    if (PcwAsic.isInterruptLine(line)) {
      this.timerPending = true;
      // A tick still on its way in when the next is raised 52 lines later
      // means no instruction has been fetched since (the CPU is not being
      // run); count the older one rather than drop it.
      if (this.tickSync !== TickSync.None) this.countTick();
      this.tickSync = TickSync.Raised;
    }
  }

  /**
   * Before an instruction executes: a raised tick is latched by its first M1.
   * `m1Cycles` is how many opcode fetches it makes before reaching its own
   * operands (2 for a CB/DD/ED/FD-prefixed instruction), and a second one
   * counts the tick at once. So `IN A,(&F4)` (one M1) loses a tick it latches,
   * while `IN A,(C)` (ED-prefixed, two M1s) has already counted it.
   */
  syncTickBefore(m1Cycles: number): void {
    if (this.tickSync !== TickSync.Raised) return;
    if (m1Cycles >= 2) {
      this.tickSync = TickSync.None;
      this.countTick();
    } else {
      this.tickSync = TickSync.Latched;
    }
  }

  /** After the instruction: the next M1 counts a latched tick, unless the
   *  instruction read &F4 and so cleared it (`readMemCtlStatus`). */
  syncTickAfter(): void {
    if (this.tickSync !== TickSync.Latched) return;
    this.tickSync = TickSync.None;
    this.countTick();
  }

  private countTick(): void {
    if (this.intCount < PCW_STATUS_COUNT_MASK) this.intCount++;
  }

  /** The ~100us timer pulse is over; drop /INT. The counter is NOT cleared
   *  here — only reading port &F4 does that. */
  endTimerPulse(): void {
    this.timerPending = false;
  }

  /** True while any source is asserting the Z80's /INT pin: the timer pulse,
   *  or a routed FDC interrupt. */
  get intPending(): boolean {
    return this.timerPending || (this.fdcInt && this.fdcRoute === 'int');
  }

  /** True while the FDC is asserting /NMI. */
  get nmiPending(): boolean {
    return this.fdcInt && this.fdcRoute === 'nmi';
  }

  /** True during the 26-line frame flyback signal. */
  get inFlyback(): boolean {
    const start = this.timing.flybackStart;
    return this.line >= start && this.line < start + PCW_FLYBACK_LINES;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  /**
   * The system status byte, read from &F8 (and, with the counter cleared
   * afterwards, from &F4): b7 undefined (reads 0), b6 frame flyback, b5 FDC
   * interrupt, b4 set on a 50Hz machine, b3-0 the timer counter. The spec
   * calls &F8's b3-0 and &F4's b7-4 "undefined"; on real machines they read
   * as the counter and as &F8's bits respectively (Jacob Nevins' port notes),
   * so both ports return the whole byte.
   */
  get status(): number {
    let value = this.intCount & PCW_STATUS_COUNT_MASK;
    if (this.timing.hz === 50) value |= PCW_STATUS_50HZ;
    if (this.fdcInt) value |= PCW_STATUS_FDC_INT;
    if (this.inFlyback) value |= PCW_STATUS_FLYBACK;
    return value;
  }

  /** Port &F4 read: the status byte, then the interrupt counter clears,
   *  taking with it a tick latched but not yet counted. */
  readMemCtlStatus(): number {
    const value = this.status;
    this.intCount = 0;
    if (this.tickSync === TickSync.Latched) this.tickSync = TickSync.None;
    return value;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** Physical address of the roller RAM's first entry. */
  get rollerAddress(): number {
    const block = (this.rollerBase >>> PCW_ROLLER_BLOCK_SHIFT) & 0x07;
    const offset = (this.rollerBase & PCW_ROLLER_OFFSET_MASK) * PCW_ROLLER_OFFSET_UNIT;
    return block * 0x4000 + offset;
  }

  /**
   * Physical address of the first byte of scan line `line`.
   *
   * Roller RAM is read live, one entry per line, so software that rewrites it
   * mid-frame — which is how the PCW scrolls — takes effect immediately. The
   * walk starts at entry `rollerOffset` (port &F6) and wraps within the
   * 512-byte, 256-entry table (the table base is 512-byte aligned).
   */
  lineAddress(line: number): number {
    const addr = this.rollerAddress + (((this.rollerOffset + line) & 0xFF) << 1);
    const entry = this.mem.videoByte(addr) | (this.mem.videoByte(addr + 1) << 8);
    return rollerEntryAddress(entry);
  }

  /** Paint the border. The PCW's surround is unlit phosphor in every mode —
   *  reverse video inverts the picture, not the frame around it. */
  beginFrame(pixels: Uint32Array): void {
    pixels.fill(this.paper);
  }

  /**
   * Draw one scan line of the active area.
   *
   * `line` is the raster line; only the first 256 (200 at 60Hz) are shown. The 90 bytes
   * are gathered with a stride of 8 (they are the same pixel row of 90
   * consecutive character cells) and expanded MSB first, so bit 7 of the first
   * byte is the leftmost pixel.
   */
  renderScanline(pixels: Uint32Array, line: number): void {
    if (line >= this.timing.displayHeight) return;

    const row = PCW_BORDER_TOP + line;
    if (row < 0 || row >= PCW_SCREEN_HEIGHT) return;

    const mem = this.mem;
    const on = this.screenEnabled && (this.videoCtl & PCW_VIDEO_ENABLE) !== 0;
    const reverse = (this.videoCtl & PCW_VIDEO_REVERSE) !== 0;

    // (b7,b6) = 00 all paper, 01 normal, 10 all ink, 11 inverse — the four
    // combinations Jacob Nevins' port notes give for the two &F7 bits.
    let fg: number;
    let bg: number;
    if (!on) {
      fg = bg = reverse ? this.ink : this.paper;
    } else {
      fg = reverse ? this.paper : this.ink;
      bg = reverse ? this.ink : this.paper;
    }

    let out = row * PCW_SCREEN_WIDTH + PCW_BORDER_LEFT;

    if (fg === bg) {
      pixels.fill(fg, out, out + PCW_BYTES_PER_LINE * 8);
      return;
    }

    let addr = this.lineAddress(line);
    for (let i = 0; i < PCW_BYTES_PER_LINE; i++) {
      const bits = mem.videoByte(addr);
      pixels[out] = bits & 0x80 ? fg : bg;
      pixels[out + 1] = bits & 0x40 ? fg : bg;
      pixels[out + 2] = bits & 0x20 ? fg : bg;
      pixels[out + 3] = bits & 0x10 ? fg : bg;
      pixels[out + 4] = bits & 0x08 ? fg : bg;
      pixels[out + 5] = bits & 0x04 ? fg : bg;
      pixels[out + 6] = bits & 0x02 ? fg : bg;
      pixels[out + 7] = bits & 0x01 ? fg : bg;
      out += 8;
      addr = (addr + PCW_LINE_BYTE_STRIDE) & PCW_VIDEO_ADDRESS_MASK;
    }
  }
}
