/**
 * MGT SAM Mouse Interface.
 *
 * The mouse hangs off the SAM's proprietary 8-pin DIN port and is read through
 * the KEYBOARD port with every address line above A7 high — `IN A,(&FFFE)`,
 * which the Technical Manual calls RDMSEL. That is the same port the keyboard
 * matrix answers on, so the interface only speaks when NO keyboard row is
 * selected; the value it returns is ANDed into the keyboard bits, exactly as
 * the real bus does.
 *
 * The protocol is a nine-byte nibble stream, restarted by a gap in the reads:
 *
 *     strobe, dummy, buttons, Y2 Y1 Y0, X2 X1 X0
 *
 * Each read returns `0xF0 | byte`, so only the low nibble carries data (that is
 * all the port has left after the keyboard's five bits). The two leading 0xFF
 * bytes are the strobe the driver syncs on. Movement is a 12-bit two's
 * complement value split most-significant-nibble first, and buttons are
 * INVERTED — a 0 bit means pressed.
 *
 * Two details are load-bearing and easy to get backwards:
 *
 *  - **The movement is latched once, at the buttons byte**, not sampled per
 *    read. Re-reading the accumulator mid-sequence would hand the driver an X
 *    from one moment and a Y from another, which shows up as a cursor that
 *    drifts diagonally when you move it along one axis.
 *  - **The reported amount is subtracted, not cleared**, once the last byte has
 *    been served. Movement that arrived during the sequence is still owed to
 *    the driver and is reported next time round; clearing instead loses it, and
 *    fast mouse movement then feels like it is being throttled.
 *
 * A gap longer than `SAM_MOUSE_RESET_US` puts the sequence back to the strobe,
 * which is how a driver that gave up mid-stream re-syncs.
 *
 * Transcribed from the SAM Coupé Technical Manual v3.0 (Mouse Port) and
 * SimCoupe's `Base/Mouse.cpp`.
 */

import { SAM_CPU_CLOCK } from './constants.ts';

/** Bytes in one mouse report. */
const BUFFER_LEN = 9;

/** Index of the buttons byte — where the movement accumulators are latched. */
const IDX_BUTTONS = 2;

/** Microseconds of silence after which the read sequence restarts. SimCoupe's
 *  `MOUSE_RESET_TIME`. */
export const SAM_MOUSE_RESET_US = 38;

/** The same gap in Z80B T-states. */
export const SAM_MOUSE_RESET_T = Math.round(SAM_CPU_CLOCK / 1_000_000 * SAM_MOUSE_RESET_US);

/** Largest movement reportable in one pass (the driver's own limit). */
const MOVE_LIMIT = 127;

function clamp(v: number): number {
  return v < -MOVE_LIMIT ? -MOVE_LIMIT : v > MOVE_LIMIT ? MOVE_LIMIT : v;
}

export class SamMouse {
  /** Fitted flag — the Hardware pane's "Mouse" toggle. When clear the port
   *  reads as bare keyboard, exactly as a SAM with nothing in the mouse
   *  socket. */
  enabled = true;

  /** Host movement owed to the driver but not yet reported. */
  private deltaX = 0;
  private deltaY = 0;
  /** Button state as the host sees it: bit N set = button N down. */
  private buttons = 0;

  /** The nine-byte report, refilled at the buttons byte. */
  private readonly buffer = new Uint8Array(BUFFER_LEN);
  /** Next byte of the report to serve. */
  private index = 0;
  /** T-state of the previous read, for the inter-read gap. */
  private lastReadT = 0;
  /** Movement handed over in the report currently being read, so it can be
   *  subtracted (not cleared) once the last byte has gone out. */
  private reportedX = 0;
  private reportedY = 0;

  constructor() { this.reset(); }

  reset(): void {
    this.deltaX = 0;
    this.deltaY = 0;
    this.buttons = 0;
    this.reportedX = 0;
    this.reportedY = 0;
    this.index = 0;
    this.lastReadT = 0;
    this.sequential = false;
    this.buffer.fill(0);
    // The strobe pair is constant; everything else is filled in on latch.
    this.buffer[0] = 0xFF;
    this.buffer[1] = 0xFF;
  }

  /** Host pointer movement, in screen pixels. Y is inverted here rather than
   *  in the pane: which way up a machine's mouse counts is the machine's
   *  business, not the capture widget's. */
  motion(dx: number, dy: number): void {
    this.deltaX += dx;
    this.deltaY -= dy;
  }

  /** Host button 0/1/2 → interface buttons 1/2/3. */
  button(index: number, pressed: boolean): void {
    if (index < 0 || index > 2) return;
    const bit = 1 << index;
    if (pressed) this.buttons |= bit;
    else this.buttons &= ~bit;
  }

  /**
   * True when the last read continued a report rather than starting one.
   *
   * This is what "the mouse is being used" means, and the distinction matters
   * for the activity LED: the ROM's own driver pokes this port once a frame
   * forever, and counting those would light MOUSE from boot to power-off — the
   * same trap the EAR indicator fell into. A driver actually reading a mouse
   * takes all nine bytes in a burst, well inside the restart window.
   */
  sequential = false;

  /**
   * Serve one byte of the report.
   *
   * `tStates` is the CPU time of this read, used only for the restart gap.
   * Returns the full port value (`0xF0 | nibble`); the caller ANDs it into the
   * keyboard bits.
   */
  read(tStates: number): number {
    if (!this.enabled) return 0xFF;

    // A pause long enough that the driver has plainly stopped reading puts the
    // sequence back to its strobe, so the next read starts a fresh report.
    const gap = tStates - this.lastReadT;
    const restart = gap < 0 || gap > SAM_MOUSE_RESET_T;
    if (restart) this.index = 0;
    this.sequential = !restart;
    this.lastReadT = tStates;

    if (this.index === IDX_BUTTONS) this.latch();

    const value = this.buffer[this.index];
    this.index++;

    if (this.index >= BUFFER_LEN) {
      // Everything in this report has been delivered: retire exactly what was
      // reported and leave any movement that arrived meanwhile owing.
      this.deltaX -= this.reportedX;
      this.deltaY -= this.reportedY;
      this.reportedX = 0;
      this.reportedY = 0;
      this.index = 0;
    }

    return 0xF0 | value;
  }

  /** Freeze the current button and movement state into the report. */
  private latch(): void {
    // Buttons are active low on the wire.
    this.buffer[IDX_BUTTONS] = (~this.buttons) & 0xFF;

    const x = clamp(this.deltaX);
    const y = clamp(this.deltaY);
    this.reportedX = x;
    this.reportedY = y;

    // 12-bit two's complement, most significant nibble first.
    const x12 = x & 0xFFF;
    const y12 = y & 0xFFF;
    this.buffer[3] = (y12 >> 8) & 0x0F;
    this.buffer[4] = (y12 >> 4) & 0x0F;
    this.buffer[5] = y12 & 0x0F;
    this.buffer[6] = (x12 >> 8) & 0x0F;
    this.buffer[7] = (x12 >> 4) & 0x0F;
    this.buffer[8] = x12 & 0x0F;
  }
}
