/**
 * SAM Coupé memory contention.
 *
 * The ASIC does not stall the CPU the way the Spectrum's ULA does. Instead the
 * video circuitry owns most of the memory bus, and **each instruction's
 * duration is rounded up** to the slot width in force where the raster is:
 *
 *   - over the border, and on any non-display line, a multiple of **four**;
 *   - over the 256-pixel display window, a multiple of **eight**;
 *   - ports 0xF8-0xFF (the ASIC's own registers) are always eight, wherever the
 *     raster happens to be;
 *   - with the screen off the whole field behaves as border.
 *
 * Mode 1 additionally applies the display rule to alternating 8-cell groups of
 * the border, because its attribute fetch is spread differently.
 *
 * The rounding is deliberately **per instruction, not per memory access**.
 * Applied per access, a 7 T-state `LD A,(HL)` would cost about 21 T in the
 * display area — a threefold slowdown, which is nothing like a real SAM.
 * Rounded per instruction it costs 8, which is the ~10-15% penalty typical
 * code actually sees. This also keeps the check to one test per instruction
 * rather than one per bus cycle.
 *
 * Timing is measured from the start of the current scanline rather than from
 * absolute T-states, because the CPU overruns each line's budget slightly and
 * an absolute modulo would drift out of phase with the raster over a field.
 *
 * TODO(verify): the line phase and the alternating mode 1 band now follow
 * SimCoupe's contention tables, but two details remain unconfirmed against the
 * Technical Manual — whether modes 3/4 (which fetch twice the data) stall
 * differently again, and whether code running from ROM is contended at all (it
 * is treated here as uncontended). Accuracy "Fast" turns the whole thing off if
 * it proves wrong.
 */

import {
  SAM_DISPLAY_FIRST_LINE, SAM_DISPLAY_FIRST_T, SAM_DISPLAY_LAST_LINE,
  SAM_T_PER_LINE,
} from './constants.ts';

/**
 * Fine phase offset applied before the line is divided into slots — SimCoupe's
 * `CPU_CYCLES_SCREEN_CONTENTION_OFFSET`, which it adds when building its
 * contention tables.
 */
const CONTENTION_T_OFFSET = 4;

/** Slot width over the border and off-screen: RAM one cycle in four. */
const SLOT_BORDER = 4;
/** Slot width over the active display: RAM one cycle in eight. */
const SLOT_DISPLAY = 8;

export class SamContention {
  /** Master switch (the `sam-contention` setting; cleared under turbo). */
  enabled = true;

  private lineStartT = 0;
  private displayLine = false;
  private mode1 = false;

  /** Latch the raster state for the scanline about to run. */
  beginLine(line: number, tStates: number, mode: number, screenOff: boolean): void {
    this.lineStartT = tStates;
    this.displayLine = !screenOff
      && line >= SAM_DISPLAY_FIRST_LINE && line < SAM_DISPLAY_LAST_LINE;
    this.mode1 = mode === 1;
  }

  /**
   * Slot width in T-states for a RAM access at `t`.
   *
   * Measured in CPU time, the display fetch runs from `SAM_DISPLAY_FIRST_T` to
   * the end of the line — two side borders in, because the beam itself lags the
   * CPU's line boundary by one (see `SAM_ASIC_T_OFFSET`). Getting that phase
   * wrong contends the wrong eight cells at each end of every display line.
   */
  slotFor(t: number): number {
    if (!this.displayLine) return SLOT_BORDER;
    const lineCycle = (t - this.lineStartT + CONTENTION_T_OFFSET) % SAM_T_PER_LINE;
    if (lineCycle >= SAM_DISPLAY_FIRST_T) return SLOT_DISPLAY;
    // Mode 1's attribute fetch reaches into alternate 8-cell (64 T) groups.
    if (this.mode1 && (lineCycle & 0x40) === 0) return SLOT_DISPLAY;
    return SLOT_BORDER;
  }

  /**
   * Extra T-states owed by an instruction that started at `startT` and ran for
   * `elapsed` cycles: its duration rounds up to the slot width in force where
   * it began. Zero when the duration is already a whole number of slots.
   */
  instructionDelay(startT: number, elapsed: number): number {
    if (!this.enabled || elapsed <= 0) return 0;
    const slot = this.slotFor(startT);
    const over = elapsed % slot;
    return over === 0 ? 0 : slot - over;
  }

  /** Ports 0xF8-0xFF are the ASIC's own, and always take the wide slot. */
  portDelay(t: number, port: number): number {
    if (!this.enabled) return 0;
    if ((port & 0xF8) !== 0xF8) return 0;
    const phase = (t - this.lineStartT) % SLOT_DISPLAY;
    return phase === 0 ? 0 : SLOT_DISPLAY - phase;
  }
}
