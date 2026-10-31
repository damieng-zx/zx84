/**
 * Commodore 64 timing and frame geometry.
 *
 * The VIC-II runs the machine: its dot clock divided by eight is the CPU's
 * phi2, so one CPU cycle is eight pixels. PAL (the 6569) has 63 cycles a
 * line and 312 lines; NTSC (the 6567R8) 65 cycles and 263 lines. The
 * constants below are the PAL machine's; `c64Timing` gives either.
 */

/** CPU (phi2) clock of the PAL C64: 17.734475 MHz / 18. */
export const C64_CPU_CLOCK = 985_248;
export const C64_CYCLES_PER_LINE = 63;
export const C64_LINES_PER_FRAME = 312;
export const C64_CYCLES_PER_FRAME = C64_CYCLES_PER_LINE * C64_LINES_PER_FRAME;

/**
 * The visible picture, in the VIC-II's sprite X coordinates and raster lines:
 * 32 pixels of border either side of the 320-pixel display window (X 24-343)
 * and the lines from 16 to 287, around the 200-line window (lines 51-250).
 * This is the area a PAL television shows of the frame.
 */
export const C64_FIRST_X = -8;
export const C64_FIRST_LINE = 16;
export const C64_SCREEN_WIDTH = 384;
export const C64_SCREEN_HEIGHT = 272;
export const C64_ACTIVE_WIDTH = 320;
export const C64_ACTIVE_HEIGHT = 200;
/** Where the display window starts in the frame buffer. */
export const C64_BORDER_LEFT = 24 - C64_FIRST_X;
export const C64_BORDER_TOP = 51 - C64_FIRST_LINE;

/**
 * Everything about the machine that follows the TV standard. The cycles of
 * the line are the VIC-II's: the 40-column display window sits at the same
 * cycles (c-accesses 15-54) on both chips, and the NTSC chip's two extra
 * cycles come after the sprite-DMA check, so the sprite fetches and the row
 * counter update move two cycles later in the line.
 */
export interface C64Timing {
  readonly ntsc: boolean;
  /** CPU (phi2) clock in Hz. */
  readonly clockHz: number;
  readonly cyclesPerLine: number;
  readonly linesPerFrame: number;
  readonly cyclesPerFrame: number;
  /** First raster line in the frame buffer, and how many lines it holds. */
  readonly firstLine: number;
  readonly screenHeight: number;
  /** Frame-buffer rows above the 200-line display window (line 51). */
  readonly borderTop: number;
  /** Line cycle (0-based) of the RC/VCBASE update and the first sprite
   *  pointer fetch (Bauer's cycle 58 on PAL). */
  readonly lineEndCycle: number;
}

export function c64Timing(ntsc: boolean): C64Timing {
  if (!ntsc) {
    return {
      ntsc, clockHz: C64_CPU_CLOCK, cyclesPerLine: C64_CYCLES_PER_LINE,
      linesPerFrame: C64_LINES_PER_FRAME, cyclesPerFrame: C64_CYCLES_PER_FRAME,
      firstLine: C64_FIRST_LINE, screenHeight: C64_SCREEN_HEIGHT, borderTop: C64_BORDER_TOP,
      lineEndCycle: 57,
    };
  }
  // 17.734472 MHz crystal / 14 / 8 on the NTSC board: 1.022727 MHz, 263 lines
  // of 65 cycles = 59.83 Hz. A TV shows about 235 of the lines.
  const firstLine = 27;
  return {
    ntsc, clockHz: C64_NTSC_CPU_CLOCK, cyclesPerLine: 65, linesPerFrame: 263,
    cyclesPerFrame: 65 * 263, firstLine, screenHeight: 235, borderTop: 51 - firstLine,
    lineEndCycle: 59,
  };
}

/** CPU (phi2) clock of the NTSC C64: 14.31818 MHz / 14. */
export const C64_NTSC_CPU_CLOCK = 1_022_727;

/** ROM image sizes: BASIC and KERNAL are 8K each, the character ROM 4K. */
export const C64_BASIC_SIZE = 0x2000;
export const C64_KERNAL_SIZE = 0x2000;
export const C64_CHARGEN_SIZE = 0x1000;
/** The system ROM as the ROM host serves it: BASIC, KERNAL, then characters. */
export const C64_ROM_SIZE = C64_BASIC_SIZE + C64_KERNAL_SIZE + C64_CHARGEN_SIZE;
