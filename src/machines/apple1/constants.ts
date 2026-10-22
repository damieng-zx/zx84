/** Apple I hardware constants. */

/** 6502 clock (the 14.31818 MHz crystal divided by 14), as on the Apple II. */
export const APPLE1_CPU_CLOCK = 1_022_727;

/** 65 CPU cycles per scanline, 262 scanlines per NTSC field. */
export const APPLE1_CYCLES_PER_LINE = 65;
export const APPLE1_LINES_PER_FRAME = 262;
export const APPLE1_TSTATES_PER_FRAME = APPLE1_CYCLES_PER_LINE * APPLE1_LINES_PER_FRAME;
/** Field rate the frame loop is paced at (the machine's own, not the default 50 Hz). */
export const APPLE1_FRAME_HZ = APPLE1_CPU_CLOCK / APPLE1_TSTATES_PER_FRAME;

/**
 * The display is a terminal: 40 columns by 24 rows of 7×8-dot cells, a 5×7
 * glyph in each. The picture is 280 dots by 192 lines inside a black border.
 */
export const APPLE1_TERMINAL_COLS = 40;
export const APPLE1_TERMINAL_ROWS = 24;
export const APPLE1_CELL_WIDTH = 7;
export const APPLE1_CELL_HEIGHT = 8;
export const APPLE1_ACTIVE_WIDTH = APPLE1_TERMINAL_COLS * APPLE1_CELL_WIDTH;
export const APPLE1_ACTIVE_HEIGHT = APPLE1_TERMINAL_ROWS * APPLE1_CELL_HEIGHT;
export const APPLE1_BORDER_LEFT = 32;
export const APPLE1_BORDER_TOP = 24;
export const APPLE1_SCREEN_WIDTH = APPLE1_ACTIVE_WIDTH + APPLE1_BORDER_LEFT * 2;
export const APPLE1_SCREEN_HEIGHT = APPLE1_ACTIVE_HEIGHT + APPLE1_BORDER_TOP * 2;

/** A 280×192 picture shown at 4:3: pixels are slightly narrower than they are tall. */
export const APPLE1_PIXEL_ASPECT_X = (APPLE1_ACTIVE_HEIGHT * 4 / 3) / APPLE1_ACTIVE_WIDTH;

/** The terminal accepts 60 characters a second; port B bit 7 reads high (busy)
 *  for this many CPU cycles after each one is written. */
export const APPLE1_CHAR_CYCLES = Math.round(APPLE1_CPU_CLOCK / 60);

/** PIA registers sit at $D010-$D013 (KBD, KBDCR, DSP, DSPCR). */
export const APPLE1_PIA_BASE = 0xD010;
/** The Woz Monitor PROM occupies the top page, $FF00-$FFFF. */
export const APPLE1_ROM_BASE = 0xFF00;
export const APPLE1_ROM_SIZE = 0x100;
