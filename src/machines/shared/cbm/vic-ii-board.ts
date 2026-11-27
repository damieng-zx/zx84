/**
 * What the Commodore 64 and the Commodore 128 share around their VIC-II: the
 * TV-standard timing of the line and frame, the part of the frame a screen
 * shows, and the sixteen colours.
 *
 * The VIC-II runs the machine: its dot clock divided by eight is the CPU's
 * phi2, so one CPU cycle is eight pixels. PAL (the 6569, and the 128's 8566)
 * has 63 cycles a line and 312 lines; NTSC (the 6567R8 and the 8564) 65 cycles
 * and 263 lines. The constants below are the PAL machine's; `vicBoardTiming`
 * gives either.
 */

import { VIC_FIRST_X, VIC_SCREEN_WIDTH } from '@/cores/vic-ii.ts';

/** CPU (phi2) clock of a PAL machine: 17.734475 MHz / 18. */
export const VIC_PAL_CPU_CLOCK = 985_248;
/** CPU (phi2) clock of an NTSC machine: 14.31818 MHz / 14. */
export const VIC_NTSC_CPU_CLOCK = 1_022_727;
export const VIC_PAL_CYCLES_PER_LINE = 63;
export const VIC_PAL_LINES_PER_FRAME = 312;
export const VIC_PAL_CYCLES_PER_FRAME = VIC_PAL_CYCLES_PER_LINE * VIC_PAL_LINES_PER_FRAME;

/**
 * The visible picture, in the VIC-II's sprite X coordinates and raster lines:
 * 32 pixels of border either side of the 320-pixel display window (X 24-343)
 * and the lines from 16 to 287, around the 200-line window (lines 51-250).
 * This is the area a PAL television shows of the frame.
 */
export const VIC_BOARD_FIRST_X = VIC_FIRST_X;
export const VIC_BOARD_FIRST_LINE = 16;
export const VIC_BOARD_SCREEN_WIDTH = VIC_SCREEN_WIDTH;
export const VIC_BOARD_SCREEN_HEIGHT = 272;
export const VIC_BOARD_ACTIVE_WIDTH = 320;
export const VIC_BOARD_ACTIVE_HEIGHT = 200;
/** Where the display window starts in the frame buffer. */
export const VIC_BOARD_BORDER_LEFT = 24 - VIC_BOARD_FIRST_X;
export const VIC_BOARD_BORDER_TOP = 51 - VIC_BOARD_FIRST_LINE;

/**
 * Everything about the machine that follows the TV standard. The cycles of
 * the line are the VIC-II's: the 40-column display window sits at the same
 * cycles (c-accesses 15-54) on both chips, and the NTSC chip's two extra
 * cycles come after the sprite-DMA check, so the sprite fetches and the row
 * counter update move two cycles later in the line.
 */
export interface VicBoardTiming {
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

export function vicBoardTiming(ntsc: boolean): VicBoardTiming {
  if (!ntsc) {
    return {
      ntsc, clockHz: VIC_PAL_CPU_CLOCK, cyclesPerLine: VIC_PAL_CYCLES_PER_LINE,
      linesPerFrame: VIC_PAL_LINES_PER_FRAME, cyclesPerFrame: VIC_PAL_CYCLES_PER_FRAME,
      firstLine: VIC_BOARD_FIRST_LINE, screenHeight: VIC_BOARD_SCREEN_HEIGHT,
      borderTop: VIC_BOARD_BORDER_TOP, lineEndCycle: 57,
    };
  }
  // 17.734472 MHz crystal / 14 / 8 on the NTSC board: 1.022727 MHz, 263 lines
  // of 65 cycles = 59.83 Hz. A TV shows about 235 of the lines.
  const firstLine = 27;
  return {
    ntsc, clockHz: VIC_NTSC_CPU_CLOCK, cyclesPerLine: 65, linesPerFrame: 263,
    cyclesPerFrame: 65 * 263, firstLine, screenHeight: 235, borderTop: 51 - firstLine,
    lineEndCycle: 59,
  };
}

/**
 * The VIC-II's sixteen colours.
 *
 * The chip makes them as luminance and chroma, so any RGB set is a measurement
 * of one chip on one display. This is the "Colodore" set (Philip Timmermann's
 * 2017 measurements of a PAL 6569), which most C64 people now regard as the
 * closest to a real machine on a real TV.
 */
const COLODORE: readonly number[] = [
  0x000000, 0xFFFFFF, 0x813338, 0x75CEC8, 0x8E3C97, 0x56AC4D, 0x2E2C9B, 0xEDF171,
  0x8E5029, 0x553800, 0xC46C71, 0x4A4A4A, 0x7B7B7B, 0xA9FF9F, 0x706DEB, 0xB2B2B2,
];

/** The palette as 32-bit pixels for a little-endian RGBA frame buffer. */
export const VIC_PALETTE: Uint32Array = (() => {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const rgb = COLODORE[i];
    const r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, b = rgb & 0xFF;
    out[i] = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  return out;
})();

/** Colour names, for the debugger. */
export const VIC_COLOUR_NAMES: readonly string[] = [
  'black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow',
  'orange', 'brown', 'light red', 'dark grey', 'grey', 'light green', 'light blue', 'light grey',
];
