/**
 * PcwAsic — the PCW's custom gate array.
 *
 * This is the machine's only piece of custom silicon, and it does four jobs
 * that on other machines belong to four different chips:
 *
 *   1. **Video.** A 720x256 monochrome bitmap fetched through *roller RAM* —
 *      a 256-entry table in main memory, one entry per scan line, each giving
 *      the physical address that line's pixels start at.
 *   2. **The 300Hz timer**, six interrupts per field, plus the counter of them
 *      that software reads back through port &F4.
 *   3. **The system status byte** read from &F4/&F8 (flyback, FDC interrupt).
 *   4. **Routing the uPD765A's interrupt** to /INT, /NMI or nowhere.
 *
 * Screen memory is stored as 8-byte character cells, so the 90 bytes of one
 * scan line are 8 apart in memory and the roller entry's low 3 bits pick the
 * pixel row within the cell. See `renderScanline`.
 */

import type { PcwMemory } from './pcw-memory.ts';
import {
  PCW_BYTES_PER_LINE, PCW_DISPLAY_HEIGHT, PCW_FIRST_INT_LINE, PCW_GREEN_INK,
  PCW_GREEN_PAPER, PCW_INT_LINE_SPACING, PCW_LINE_BYTE_STRIDE, PCW_LINES_PER_FRAME,
  PCW_ROLLER_BLOCK_SHIFT, PCW_ROLLER_OFFSET_MASK, PCW_ROLLER_OFFSET_UNIT,
  PCW_SCREEN_HEIGHT, PCW_SCREEN_WIDTH, PCW_STATUS_32_LINE, PCW_STATUS_COUNT_MASK,
  PCW_STATUS_FDC_INT, PCW_STATUS_FLYBACK, PCW_VIDEO_ADDRESS_MASK, PCW_VIDEO_ENABLE,
  PCW_VIDEO_REVERSE, PCW_BORDER_LEFT, PCW_BORDER_TOP,
} from './constants.ts';

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
  /** Port &F6: vertical position of the picture on the monitor. */
  verticalPos = 0;
  /** Port &F7: b6 screen enable, b7 reverse video. */
  videoCtl = PCW_VIDEO_ENABLE;
  /** Port &F8 commands 7/8 — screen on/off for external video. ANDed with the
   *  &F7 enable bit, so either one can blank the picture. */
  screenEnabled = true;

  /** Phosphor colours, swapped by the `pcw-phosphor` setting. */
  ink = PCW_GREEN_INK;
  paper = PCW_GREEN_PAPER;

  // ── Interrupt state ───────────────────────────────────────────────────────

  /** The 300Hz timer interrupt is asserted and not yet taken. */
  timerPending = false;
  /** b3-0 of the status byte: timer interrupts since the counter was last read
   *  through port &F4. Saturates at 15 — it is 4 bits wide. */
  intCount = 0;
  /** Where the FDC's interrupt goes. Nowhere until the BIOS routes it. */
  fdcRoute: FdcIntRoute = 'none';
  /** Live uPD765A interrupt line, refreshed by the machine each scan line. */
  fdcInt = false;

  /** Current raster line, 0-311. Lines 256+ are frame flyback. */
  line = 0;

  constructor(mem: PcwMemory) {
    this.mem = mem;
  }

  reset(): void {
    this.rollerBase = 0;
    this.verticalPos = 0;
    this.videoCtl = PCW_VIDEO_ENABLE;
    this.screenEnabled = true;
    this.timerPending = false;
    this.intCount = 0;
    this.fdcRoute = 'none';
    this.fdcInt = false;
    this.line = 0;
  }

  // ── Timing ────────────────────────────────────────────────────────────────

  /**
   * True when a timer interrupt fires at the *start* of `line`.
   *
   * Six per field, two lines into frame flyback and every 52 lines after:
   * 258, 310, 50, 102, 154, 206.
   */
  static isInterruptLine(line: number): boolean {
    return ((line - PCW_FIRST_INT_LINE + PCW_LINES_PER_FRAME) % PCW_LINES_PER_FRAME)
      % PCW_INT_LINE_SPACING === 0;
  }

  /** Advance to `line`, raising the timer interrupt when one falls there. */
  beginLine(line: number): void {
    this.line = line;
    if (PcwAsic.isInterruptLine(line)) {
      this.timerPending = true;
      // 4-bit counter of interrupts the CPU has not acknowledged by reading
      // &F4. It saturates rather than wrapping, so a long DI cannot make a
      // backlog of 16 look like none at all.
      if (this.intCount < PCW_STATUS_COUNT_MASK) this.intCount++;
    }
  }

  /** The CPU has taken the timer interrupt; drop /INT. The counter is NOT
   *  cleared here — only reading port &F4 does that. */
  acknowledgeTimer(): void {
    this.timerPending = false;
  }

  /** True while any source is asserting the Z80's /INT pin. */
  get intPending(): boolean {
    return this.timerPending || (this.fdcInt && this.fdcRoute === 'int');
  }

  /** True while the FDC is asserting /NMI. */
  get nmiPending(): boolean {
    return this.fdcInt && this.fdcRoute === 'nmi';
  }

  // ── Status ────────────────────────────────────────────────────────────────

  /**
   * The system status byte, read from &F8 (and, with the counter cleared
   * afterwards, from &F4).
   *
   * b6 reports frame flyback only. The reference calls it "line flyback ...
   * read twice in succession indicates frame flyback", but modelling the
   * per-line pulse as well would make two reads a few T-states apart agree by
   * coincidence for a large fraction of every displayed line — the idiom would
   * report frame flyback in the middle of the picture. Reporting the frame
   * period alone makes the documented idiom behave, at the cost of software
   * that watches for the line pulse itself, which nothing is known to do.
   */
  get status(): number {
    let value = this.intCount & PCW_STATUS_COUNT_MASK;
    // A 50Hz machine has a 32-line (256-pixel) screen.
    value |= PCW_STATUS_32_LINE;
    if (this.fdcInt) value |= PCW_STATUS_FDC_INT;
    if (this.line >= PCW_DISPLAY_HEIGHT) value |= PCW_STATUS_FLYBACK;
    return value;
  }

  /** Port &F4 read: the status byte, then the interrupt counter clears. */
  readMemCtlStatus(): number {
    const value = this.status;
    this.intCount = 0;
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
   * entry pair wraps within its own 16K block.
   */
  lineAddress(line: number): number {
    const base = this.rollerAddress;
    const offset = (base & 0x3FFF) + (line & 0xFF) * 2;
    const addr = (base & ~0x3FFF) | (offset & 0x3FFF);
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
   * `line` is the raster line, 0-255; flyback lines draw nothing. The 90 bytes
   * are gathered with a stride of 8 (they are the same pixel row of 90
   * consecutive character cells) and expanded MSB first, so bit 7 of the first
   * byte is the leftmost pixel.
   */
  renderScanline(pixels: Uint32Array, line: number): void {
    if (line >= PCW_DISPLAY_HEIGHT) return;

    const row = PCW_BORDER_TOP + this.verticalPos + line;
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
