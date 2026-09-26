/** BBC Micro Model B hardware constants. */

/** 6502 clock. The CPU is stretched to 1 MHz for slow-bus/ROM/IO accesses; the
 *  nominal frame budget below uses the full 2 MHz rate. */
export const BBC_CPU_CLOCK = 2_000_000;

/** SN76489 sound-chip clock (its own 4 MHz oscillator, independent of the CPU). */
export const BBC_SOUND_CLOCK = 4_000_000;

/** 50 Hz PAL frame. */
export const BBC_TSTATES_PER_FRAME = BBC_CPU_CLOCK / 50;

/** Full-border frame buffer. Mode 0–6 active area is 640×256; Mode 7's
 *  teletext cells are doubled to 12×20 (480×500) and centred. */
export const BBC_SCREEN_WIDTH = 640;
export const BBC_SCREEN_HEIGHT = 512;
