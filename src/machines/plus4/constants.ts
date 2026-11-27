/**
 * Commodore Plus/4 (and C16) timing and frame geometry.
 *
 * The 7501 and the TED run from the same crystal: the CPU's clock is the TED's
 * dot clock over eight, so one CPU cycle is eight TED pixels. A raster line is
 * 114 CPU cycles and a PAL frame 312 lines (49.8 Hz); the NTSC machine has 262
 * lines (59.9 Hz).
 *
 * A 40-column character row is eight lines and 114 cycles of each, and on the
 * line its row counter matches YSCROLL the TED fetches the whole row and holds
 * the CPU off the bus for 88 of the 114 cycles. That bad line is what makes
 * the raster compare interrupt and the display splits possible.
 *
 * The frame buffer is the picture a TV shows at the "Normal" border setting:
 * 384 × 288 (4:3), with the 320 × 200 display window 32 pixels in from either
 * side and 33 lines down. VICE's TED timing derives that crop from the chip's
 * own raster counter (its normal borders start 19 lines into the object's
 * frame, the object's frame being the chip's plus 48); the NTSC timing there
 * is marked FIXME, so this uses the same window for both standards rather than
 * invent one.
 */

/** CPU clock: the PAL Plus/4's 17.734475 MHz crystal / 10 = 1.773447 MHz. */
export const PLUS4_PAL_CLOCK = 1_773_447;
/** CPU clock of the NTSC machine: 14.31818 MHz × 1.25 / 10. */
export const PLUS4_NTSC_CLOCK = 1_789_772;

/** A line is 114 cycles on both TV standards. */
export const PLUS4_CYCLES_PER_LINE = 114;
/** The PAL frame has 312 lines; NTSC 262. */
export const PLUS4_PAL_LINES = 312;
export const PLUS4_NTSC_LINES = 262;

/** The display: 40 columns of 8 pixels, 25 rows of 8 lines. */
export const PLUS4_COLUMNS = 40;
export const PLUS4_ROWS = 25;
export const PLUS4_ACTIVE_WIDTH = PLUS4_COLUMNS * 8;
export const PLUS4_ACTIVE_HEIGHT = PLUS4_ROWS * 8;

/** The 25-row display's raster line bounds in the chip's own counter. */
export const PLUS4_DISPLAY_START = 0x04;
export const PLUS4_DISPLAY_STOP = 0xCC;

/** Frame-buffer geometry: 384 × 288, the display 32 pixels in and 33 lines down. */
export const PLUS4_FRAME_WIDTH = 384;
export const PLUS4_FRAME_HEIGHT = 288;
export const PLUS4_BORDER_LEFT = 0x20;
export const PLUS4_BORDER_TOP = 33;
/** Buffer row = raster line + this (VICE's frame offset, 48, less its crop). */
export const PLUS4_RASTER_OFFSET = 29;


/** Where a frame's raster is drawn from, and how many lines the buffer holds. */
export interface Plus4Timing {
  readonly ntsc: boolean;
  /** CPU clock in Hz (the TED's dot clock is eight times this). */
  readonly clockHz: number;
  readonly cyclesPerLine: number;
  readonly linesPerFrame: number;
  readonly cyclesPerFrame: number;
  /** Frame-buffer rows above the 200-line display window. */
  readonly borderTop: number;
  /** The 40-column display's left border, in pixels. */
  readonly borderLeft: number;
  /** The display window's first and last raster line, in the chip's counter. */
  readonly displayStart: number;
  readonly displayStop: number;
  /** Frame-buffer row = raster line + this. */
  readonly rasterOffset: number;
}

export function plus4Timing(ntsc: boolean): Plus4Timing {
  return {
    ntsc,
    clockHz: ntsc ? PLUS4_NTSC_CLOCK : PLUS4_PAL_CLOCK,
    cyclesPerLine: PLUS4_CYCLES_PER_LINE,
    linesPerFrame: ntsc ? PLUS4_NTSC_LINES : PLUS4_PAL_LINES,
    cyclesPerFrame: PLUS4_CYCLES_PER_LINE * (ntsc ? PLUS4_NTSC_LINES : PLUS4_PAL_LINES),
    borderTop: PLUS4_BORDER_TOP,
    borderLeft: PLUS4_BORDER_LEFT,
    displayStart: PLUS4_DISPLAY_START,
    displayStop: PLUS4_DISPLAY_STOP,
    rasterOffset: PLUS4_RASTER_OFFSET,
  };
}

/** The whole visible frame, in pixels. */
export function plus4Screen(_t: Plus4Timing): {
  width: number; height: number; activeWidth: number; activeHeight: number;
  borderLeft: number; borderTop: number;
} {
  return {
    width: PLUS4_FRAME_WIDTH,
    height: PLUS4_FRAME_HEIGHT,
    activeWidth: PLUS4_ACTIVE_WIDTH,
    activeHeight: PLUS4_ACTIVE_HEIGHT,
    borderLeft: PLUS4_BORDER_LEFT,
    borderTop: PLUS4_BORDER_TOP,
  };
}

/** The TED's pixel is treated as square: the buffer is a 4:3 frame and the
 *  display window fills it as a TV's picture did. */
export function plus4PixelAspect(_ntsc: boolean): number {
  return 1;
}
