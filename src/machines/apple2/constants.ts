/** Apple II / Apple II Plus hardware constants. */

/** 6502 clock (the NTSC 14.318 MHz crystal divided by 14). */
export const APPLE2_CPU_CLOCK = 1_022_727;

/** 65 CPU cycles per scanline, 262 scanlines per NTSC frame. */
export const APPLE2_CYCLES_PER_LINE = 65;
export const APPLE2_LINES_PER_FRAME = 262;
export const APPLE2_TSTATES_PER_FRAME = APPLE2_CYCLES_PER_LINE * APPLE2_LINES_PER_FRAME;

/** First scanline of vertical blanking (the 192 active lines are 0-191). */
export const APPLE2_VBL_LINE = 192;

/** Active picture: 280×192 (40 text columns × 7 pixels, 192 lines). */
export const APPLE2_ACTIVE_WIDTH = 280;
export const APPLE2_ACTIVE_HEIGHT = 192;
/** Black border around the active area. */
export const APPLE2_BORDER_LEFT = 32;
export const APPLE2_BORDER_TOP = 24;
export const APPLE2_SCREEN_WIDTH = APPLE2_ACTIVE_WIDTH + APPLE2_BORDER_LEFT * 2;
export const APPLE2_SCREEN_HEIGHT = APPLE2_ACTIVE_HEIGHT + APPLE2_BORDER_TOP * 2;

/** A 280×192 picture shown at 4:3: pixels are slightly narrower than tall. */
export const APPLE2_PIXEL_ASPECT_X = (APPLE2_ACTIVE_HEIGHT * 4 / 3) / APPLE2_ACTIVE_WIDTH;

/** Expansion slot the Disk II controller lives in. */
export const DISK2_SLOT = 6;
