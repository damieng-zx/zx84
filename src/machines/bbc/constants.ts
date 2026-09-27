/** BBC Micro Model B hardware constants. */

/** 6502 clock. The CPU is stretched to 1 MHz for slow-bus/ROM/IO accesses; the
 *  nominal frame budget below uses the full 2 MHz rate. */
export const BBC_CPU_CLOCK = 2_000_000;

/** SN76489 sound-chip clock (its own 4 MHz oscillator, independent of the CPU). */
export const BBC_SOUND_CLOCK = 4_000_000;

/** 50 Hz PAL frame. */
export const BBC_TSTATES_PER_FRAME = BBC_CPU_CLOCK / 50;

/** Active picture area in the frame buffer. Modes 0–6 are 640×256 with each
 *  scanline drawn twice; Mode 7's teletext cells are doubled to 12×20
 *  (480×500) and centred. */
export const BBC_ACTIVE_WIDTH = 640;
export const BBC_ACTIVE_HEIGHT = 512;
/** The (always black) border around it at the Normal border setting: 64
 *  pixels each side and 16 TV lines (32 buffer lines) top and bottom. */
export const BBC_BORDER_LEFT = 64;
export const BBC_BORDER_TOP = 32;
/** Full-border frame buffer. */
export const BBC_SCREEN_WIDTH = BBC_ACTIVE_WIDTH + BBC_BORDER_LEFT * 2;
export const BBC_SCREEN_HEIGHT = BBC_ACTIVE_HEIGHT + BBC_BORDER_TOP * 2;
