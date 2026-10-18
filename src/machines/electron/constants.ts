/** Acorn Electron hardware constants. */

/** 6502 clock. RAM accesses are stretched to 1 MHz by the ULA; ROM runs at 2 MHz. */
export const ELECTRON_CPU_CLOCK = 2_000_000;

/** The ULA draws 312 lines of 64 µs, one every 128 CPU cycles (50.08 Hz). */
export const ELECTRON_LINES_PER_FRAME = 312;
export const ELECTRON_CYCLES_PER_LINE = 128;
export const ELECTRON_TSTATES_PER_FRAME = ELECTRON_LINES_PER_FRAME * ELECTRON_CYCLES_PER_LINE;

/** In modes 0-3 the ULA fetches display bytes for 40 µs of every displayed
 *  64 µs line (the first 80 cycles here); the CPU is halted for a RAM access
 *  made in that window. Modes 4-6 fetch half as much and never halt it. */
export const ELECTRON_FETCH_CYCLES = 80;

/** Active picture: 640×256 pixels (modes 3 and 6 use 250 lines of it). */
export const ELECTRON_ACTIVE_WIDTH = 640;
export const ELECTRON_ACTIVE_HEIGHT = 256;
/** The black border around it at the Normal border setting. */
export const ELECTRON_BORDER_LEFT = 64;
export const ELECTRON_BORDER_TOP = 16;
/** Full-border frame buffer. */
export const ELECTRON_SCREEN_WIDTH = ELECTRON_ACTIVE_WIDTH + ELECTRON_BORDER_LEFT * 2;
export const ELECTRON_SCREEN_HEIGHT = ELECTRON_ACTIVE_HEIGHT + ELECTRON_BORDER_TOP * 2;
/** Buffer pixels are twice as tall as wide in the 640-pixel modes: show at half width. */
export const ELECTRON_PIXEL_ASPECT_X = 0.5;

/** Cassette tape rate: the ULA only reads and writes 1200 baud. */
export const ELECTRON_TAPE_BAUD = 1200;
