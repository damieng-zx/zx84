/**
 * The Sinclair ZX Printer, on I/O port 0xFB (selected by A2 low).
 *
 * Two styli on a belt sweep across aluminised paper, burning a dot wherever
 * the stylus is powered; the paper creeps forward while the motor runs, one
 * pixel row per sweep. The interface, as the printer's documentation and the
 * ZX81 ROM's COPY routine (0x0869) describe it:
 *
 *   OUT  bit 7  stylus power (1 burns)
 *        bit 2  motor: 0 runs, 1 stops
 *        bit 1  slow motor speed (used for the last two rows of a COPY)
 *   IN   bit 0  encoder: a stylus has moved on one dot position
 *        bit 6  0 when a printer is connected
 *        bit 7  a stylus has just reached the left edge of the paper
 *
 * Bits 0 and 7 are latched: once set they stay set until the computer next
 * writes to the printer. COPY waits for bit 7, then for each of the 256 dots
 * waits for bit 0 and writes the dot on bit 7 — the write clears the latch,
 * so the next encoder pulse is the next dot.
 *
 * Timing: Sinclair rate the printer at 50 characters a second, a 32-column
 * line of eight pixel rows every 0.64s, so one sweep is 80ms (260,000T at
 * 3.25MHz). Each dot position is SLOT_T long; the encoder pulses at the start
 * of every position all the way round the belt, and the dot under the stylus
 * is burnt if the stylus is powered half-way across it. Slow speed takes
 * twice as long per sweep.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

export const PRINTER_DOTS = 256;
const ROW_BYTES = PRINTER_DOTS / 8;
const SWEEP_T = 260_000;
const SLOT_T = 600;
const SLOTS_PER_SWEEP = Math.floor(SWEEP_T / SLOT_T);
/** Paper kept, in pixel rows (about 30 metres of real roll would be more;
 *  past this the last row is reused). */
export const PRINTER_MAX_ROWS = 8192;

export class ZxPrinter {
  /** The printout: ROW_BYTES per pixel row, bit 7 = leftmost dot, 1 = burnt. */
  private paper = new Uint8Array(ROW_BYTES * 64);
  private rows = 0;
  /** Bumped whenever the printout changes, so a viewer knows to redraw. */
  version = 0;

  private motorOn = false;
  private slow = false;
  private stylus = false;
  private encoderLatch = false;
  private lineLatch = false;
  /** Dot position round the belt, in sweep T-states at full speed. Starts
   *  just off the paper's right edge, so the first line comes promptly. */
  private phase = PRINTER_DOTS * SLOT_T;
  private lastT = 0;

  get rowCount(): number { return this.rows; }

  /** The printout as ROW_BYTES bytes per row (a copy). */
  paperRows(): Uint8Array { return this.paper.slice(0, this.rows * ROW_BYTES); }

  clearPaper(): void {
    this.rows = 0;
    this.paper.fill(0);
    this.version++;
  }

  /** Power-on: motor stopped, nothing latched. The paper stays. */
  reset(t: number): void {
    this.motorOn = false;
    this.slow = false;
    this.stylus = false;
    this.encoderLatch = false;
    this.lineLatch = false;
    this.lastT = t;
  }

  /** Line up the clock without moving anything (e.g. after a state load). */
  syncClock(t: number): void { this.lastT = t; }

  read(t: number): number {
    this.advance(t);
    // Bits 1-5 are not driven by the printer and float high.
    return 0x3e | (this.encoderLatch ? 0x01 : 0) | (this.lineLatch ? 0x80 : 0);
  }

  write(value: number, t: number): void {
    this.advance(t);
    this.stylus = (value & 0x80) !== 0;
    this.motorOn = (value & 0x04) === 0;
    this.slow = (value & 0x02) !== 0;
    this.encoderLatch = false;
    this.lineLatch = false;
  }

  /** Run the mechanism up to CPU time `t`. */
  advance(t: number): void {
    const elapsed = t - this.lastT;
    this.lastT = t;
    if (!this.motorOn || elapsed <= 0) return;
    const end = this.phase + (this.slow ? elapsed / 2 : elapsed);
    // Walk the events in (phase, end]: each slot's start (an encoder pulse,
    // and at slot 0 a new row and the line latch) and each slot's middle
    // (the dot under the stylus is burnt if it is powered).
    let slot = Math.floor(this.phase / SLOT_T);
    while (true) {
      const mid = slot * SLOT_T + SLOT_T / 2;
      if (mid > this.phase && mid <= end) {
        if (this.stylus && slot % SLOTS_PER_SWEEP < PRINTER_DOTS) this.burn(slot % SLOTS_PER_SWEEP);
      }
      const next = (slot + 1) * SLOT_T;
      if (next > end) break;
      slot++;
      const dot = slot % SLOTS_PER_SWEEP;
      if (dot === 0) this.newRow();
      this.encoderLatch = true;
    }
    // Keep the phase within one sweep so it never loses precision.
    const sweep = SLOTS_PER_SWEEP * SLOT_T;
    this.phase = end % sweep;
  }

  private newRow(): void {
    this.lineLatch = true;
    if (this.rows >= PRINTER_MAX_ROWS) {
      this.paper.fill(0, (this.rows - 1) * ROW_BYTES, this.rows * ROW_BYTES);
    } else {
      if ((this.rows + 1) * ROW_BYTES > this.paper.length) {
        const grown = new Uint8Array(Math.min(this.paper.length * 2, PRINTER_MAX_ROWS * ROW_BYTES));
        grown.set(this.paper);
        this.paper = grown;
      }
      this.rows++;
    }
    this.version++;
  }

  private burn(dot: number): void {
    if (this.rows === 0) return;
    const at = (this.rows - 1) * ROW_BYTES + (dot >> 3);
    const bit = 0x80 >> (dot & 7);
    if (this.paper[at] & bit) return;
    this.paper[at] |= bit;
    this.version++;
  }

  saveState(w: StateWriter): void {
    w.bool(this.motorOn); w.bool(this.slow); w.bool(this.stylus);
    w.bool(this.encoderLatch); w.bool(this.lineLatch);
    w.f64(this.phase); w.f64(this.lastT);
    w.u32(this.rows);
    w.raw(this.paper.subarray(0, this.rows * ROW_BYTES));
  }

  loadState(r: StateReader): void {
    this.motorOn = r.bool(); this.slow = r.bool(); this.stylus = r.bool();
    this.encoderLatch = r.bool(); this.lineLatch = r.bool();
    this.phase = r.f64(); this.lastT = r.f64();
    const rows = Math.min(r.u32(), PRINTER_MAX_ROWS);
    this.paper = new Uint8Array(Math.max(ROW_BYTES * 64, rows * ROW_BYTES));
    this.rows = rows;
    r.rawInto(this.paper.subarray(0, rows * ROW_BYTES));
    this.version++;
  }
}
