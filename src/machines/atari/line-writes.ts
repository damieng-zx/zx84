/**
 * The register writes of one scanline, with the CPU cycle each one landed on,
 * so the renderer can draw the line in pieces instead of with whatever the
 * GTIA/ANTIC registers hold when the line ends.
 *
 * The machine runs the CPU for a whole scanline and draws it afterwards. A
 * display-list interrupt that changes a colour or a character set in the
 * middle of a line must only change the pixels to the right of the beam, so
 * every write that can alter the picture is logged here (write-only registers
 * cannot be read back, so the value it replaced is kept too and the line can
 * be rewound to the state it started in).
 *
 * Cycle numbers are the Altirra Hardware Reference Manual's: cycle 0 of a
 * 114-cycle line is the missile DMA slot at its start, and a write's cycle is
 * the cycle its bus access lands on (the last cycle of a store).
 *
 * The log is preallocated and reused every line; recording a write allocates
 * nothing.
 */

import { ATARI_BORDER_LEFT, ATARI_PLAYFIELD_LEFT_CLOCK } from './constants.ts';
import type { Antic } from './antic.ts';
import type { Gtia } from './gtia.ts';

/** GTIA registers are logged under their own offsets ($00-$1D). PRIOR's two
 *  fields take effect at different times, so a PRIOR write is logged as two
 *  entries: bits 0-5 under REG_PRIOR and bits 6-7 under this id. */
export const REG_PRIOR = 0x1b;
export const REG_PRIOR_MODE = 0x1e;
/** HITCLR ($D01E) is logged under this id, as the id 0x1e above is taken. */
export const REG_HITCLR = 0x1f;
/** ANTIC registers are logged as ANTIC_BASE | register number. */
export const ANTIC_BASE = 0x20;
export const REG_CHACTL = ANTIC_BASE | 0x01;
export const REG_HSCROL = ANTIC_BASE | 0x04;
export const REG_CHBASE = ANTIC_BASE | 0x09;

/** Entries a line can hold; later writes still reach the chips but are drawn
 *  as if they had happened before the line began. */
const CAPACITY = 512;

/** A cut position meaning "never inside this line". */
export const NEVER = 0x7fffffff;

/**
 * Buffer x at which a write made on `cycle` starts to show, by the manual's
 * chapter 6.10 timing for writes to GTIA mid-line. The write itself lands at
 * colour clock 2*cycle - 2, and after it the change reaches the screen:
 *
 *   colour registers      1 clock later    (a write on cycle 65 shows at $81)
 *   PRIOR bits 0-5        2 clocks later
 *   GRAFPn / GRAFM        3 clocks later
 *   SIZEPn / SIZEM        3 clocks later
 *   HITCLR                3 clocks later
 *   PRIOR bits 6-7        4 clocks later   (3-5 on the real chip)
 *   HPOSPn / HPOSMn       5 clocks later
 *
 * A buffer pixel is half a colour clock and colour clock 48 sits at buffer x
 * 8, so x = 8 + 2 * (clock - 48).
 *
 * ANTIC's CHBASE (which the manual says takes effect two cycles after the
 * write) and CHACTL are used when a glyph row is fetched, about two cycles
 * before the glyph is shifted out, so they are cut eight clocks after the
 * write; the renderer then moves the cut to a character boundary. HSCROL is
 * sampled once as the line starts and never cuts a line.
 */
export function writeCutX(reg: number, cycle: number): number {
  let clock: number;
  if (reg <= 0x07) clock = 2 * cycle + 3; // HPOSP, HPOSM
  else if (reg <= 0x11) clock = 2 * cycle + 1; // SIZEP, SIZEM, GRAFP, GRAFM
  else if (reg <= 0x1a) clock = 2 * cycle - 1; // COLPM, COLPF, COLBK
  else if (reg === REG_PRIOR) clock = 2 * cycle;
  else if (reg === REG_PRIOR_MODE) clock = 2 * cycle + 2;
  else if (reg <= 0x1d || reg === REG_HITCLR) clock = 2 * cycle + 1; // VDELAY, GRACTL, HITCLR
  else if (reg === REG_CHACTL || reg === REG_CHBASE) clock = 2 * cycle + 8;
  else return NEVER;
  return ATARI_BORDER_LEFT + (clock - ATARI_PLAYFIELD_LEFT_CLOCK) * 2;
}

/** Put a register back to (or set it to) `value` without any side effect on
 *  the rest of the chip. */
export function applyWrite(gtia: Gtia, antic: Antic, reg: number, value: number): void {
  if (reg < ANTIC_BASE) {
    if (reg === REG_PRIOR) gtia.prior = (gtia.prior & 0xC0) | (value & 0x3F);
    else if (reg === REG_PRIOR_MODE) gtia.prior = (gtia.prior & 0x3F) | (value & 0xC0);
    else if (reg === REG_HITCLR) gtia.writeReg(0x1E, 0);
    else gtia.writeReg(reg, value);
  } else {
    antic.writeReg(0xD400 | (reg & 0x0F), value);
  }
}

export class LineWrites {
  /** Entries logged this line. */
  count = 0;
  /** Entries below this index have their cycle (those above are still inside
   *  the instruction that is executing). */
  stamped = 0;
  readonly cycle = new Int16Array(CAPACITY);
  readonly reg = new Uint8Array(CAPACITY);
  readonly value = new Uint8Array(CAPACITY);
  /** What the register held before the write. */
  readonly old = new Uint8Array(CAPACITY);

  clear(): void {
    this.count = 0;
    this.stamped = 0;
  }

  /** True while entries are waiting for the instruction's last cycle. */
  get pending(): boolean { return this.count > this.stamped; }

  /** Give every entry logged since the last stamp its cycle. */
  stamp(cycle: number): void {
    const c = cycle < 0 ? 0 : cycle;
    for (let i = this.stamped; i < this.count; i++) this.cycle[i] = c;
    this.stamped = this.count;
  }

  /** Log a write to GTIA register `a` ($00-$1D); `old` is what it held. */
  addGtia(a: number, value: number, old: number): void {
    if (a === REG_PRIOR) {
      this.add(REG_PRIOR, value, old);
      this.add(REG_PRIOR_MODE, value, old);
    } else if (a === 0x1E) {
      // HITCLR clears the collision latches whatever it is given; there is no
      // value to compare, so make it always differ.
      this.add(REG_HITCLR, 0, 0xFF);
    } else {
      this.add(a, value, old);
    }
  }

  /** Log a write to the ANTIC register `a` (CHACTL, HSCROL, CHBASE). */
  addAntic(a: number, value: number, old: number): void {
    this.add(ANTIC_BASE | a, value, old);
  }

  private add(reg: number, value: number, old: number): void {
    const n = this.count;
    if (n >= CAPACITY) return;
    // Rewriting what a register already holds changes nothing (games store
    // the same colours every line), so it is not worth a split.
    if (reg >= 0x12 && reg <= 0x1a ? (value & 0xFE) === old : reg === REG_HSCROL ? (value & 0x0F) === old : value === old) return;
    this.reg[n] = reg;
    this.value[n] = value;
    this.old[n] = old;
    this.cycle[n] = 0;
    this.count = n + 1;
  }
}
