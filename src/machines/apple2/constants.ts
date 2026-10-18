/** Apple II / Apple II Plus hardware constants. */

/** 6502 clock (the NTSC 14.318 MHz crystal divided by 14). */
export const APPLE2_CPU_CLOCK = 1_022_727;

/** 65 CPU cycles per scanline, 262 scanlines per NTSC frame. */
export const APPLE2_CYCLES_PER_LINE = 65;
export const APPLE2_LINES_PER_FRAME = 262;
export const APPLE2_TSTATES_PER_FRAME = APPLE2_CYCLES_PER_LINE * APPLE2_LINES_PER_FRAME;

/** First scanline of vertical blanking (the 192 active lines are 0-191). */
export const APPLE2_VBL_LINE = 192;

/**
 * Active picture. The video generator's dot is 560 per line (80 text columns ×
 * 7, or double hi-res), so the frame buffer is 560 wide and the ordinary 280-dot
 * modes (40-column text, lores, hires) are drawn pixel-doubled. 192 lines tall.
 */
export const APPLE2_ACTIVE_WIDTH = 560;
export const APPLE2_ACTIVE_HEIGHT = 192;
/** Horizontal pixels of the 40-column / lores / hires modes (one per 14 MHz/2). */
export const APPLE2_NARROW_WIDTH = 280;
/** Black border around the active area. */
export const APPLE2_BORDER_LEFT = 64;
export const APPLE2_BORDER_TOP = 24;
export const APPLE2_SCREEN_WIDTH = APPLE2_ACTIVE_WIDTH + APPLE2_BORDER_LEFT * 2;
export const APPLE2_SCREEN_HEIGHT = APPLE2_ACTIVE_HEIGHT + APPLE2_BORDER_TOP * 2;

/** A 560×192 picture shown at 4:3: pixels are about half as wide as they are tall. */
export const APPLE2_PIXEL_ASPECT_X = (APPLE2_ACTIVE_HEIGHT * 4 / 3) / APPLE2_ACTIVE_WIDTH;

/** Expansion slot the Disk II controller lives in. */
export const DISK2_SLOT = 6;
