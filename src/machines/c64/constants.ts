/**
 * Commodore 64 timing and frame geometry (PAL: the 6569 VIC-II).
 *
 * The VIC-II runs the machine: its 7.88 MHz dot clock divided by eight is the
 * CPU's phi2, so one CPU cycle is eight pixels and one raster line is 63
 * cycles; a frame is 312 lines.
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

/** ROM image sizes: BASIC and KERNAL are 8K each, the character ROM 4K. */
export const C64_BASIC_SIZE = 0x2000;
export const C64_KERNAL_SIZE = 0x2000;
export const C64_CHARGEN_SIZE = 0x1000;
/** The system ROM as the ROM host serves it: BASIC, KERNAL, then characters. */
export const C64_ROM_SIZE = C64_BASIC_SIZE + C64_KERNAL_SIZE + C64_CHARGEN_SIZE;
