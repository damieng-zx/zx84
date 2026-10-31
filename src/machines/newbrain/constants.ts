/**
 * Grundy NewBrain hardware constants.
 *
 * A Z80A at 4 MHz (16 MHz crystal / 4), 32K of RAM at 0000-7FFF, 24K of ROM at
 * A000-FFFF and a COP420 microcontroller that scans the keyboard, drives the
 * 16-character vacuum-fluorescent display and the cassette relays, and talks
 * to the Z80 through port 6. Video is a discrete TTL circuit reading text (or
 * raw graphics bytes) straight out of main RAM.
 *
 *   0000-7FFF  RAM (32K), shared with the video circuit
 *   8000-9FFF  nothing on the unexpanded machine — reads 0xFF
 *   A000-BFFF  ROM  (the A bank)
 *   C000-DFFF  ROM  (the CD bank)
 *   E000-FFFF  ROM  (the EF bank)
 *
 * At power-up the board forces the top ROM bank over the whole address space
 * and switches RAM off until a power-up timer expires; the Z80 starts at 0000
 * and so runs the E000 bank's start-up code.
 */

/** Z80 clock (Hz). */
export const NB_CPU_CLOCK = 4_000_000;

/** Field rate. */
export const NB_FRAME_HZ = 50;
export const NB_LINES_PER_FRAME = 312;
export const NB_T_PER_FRAME = NB_CPU_CLOCK / NB_FRAME_HZ;
export const NB_T_PER_LINE = NB_T_PER_FRAME / NB_LINES_PER_FRAME;

/** Scanlines of picture (the video circuit draws 250 lines of 640 dots). */
export const NB_ACTIVE_LINES = 250;
export const NB_SCREEN_WIDTH = 640;
export const NB_SCREEN_HEIGHT = NB_ACTIVE_LINES;

/** Z80 T-states the board's power-up timer takes (about 5.6 ms). */
export const NB_POWERUP_T = 22_400;

/** The COP420 runs one instruction cycle per 16 CKI clocks, CKI being the
 *  4 MHz system clock. */
export const NB_T_PER_COP_CYCLE = 16;

export const NB_RAM_SIZE = 0x8000;
export const NB_ROM_BASE = 0xA000;
/** The three 8K ROM sockets, A000 up. */
export const NB_ROM_SIZE = 0x6000;
export const NB_COP_ROM_SIZE = 0x400;
export const NB_CHAR_ROM_SIZE = 0x1000;
/** The combined system image: Z80 ROMs, then the COP firmware, then the
 *  character generator. */
export const NB_IMAGE_SIZE = NB_ROM_SIZE + NB_COP_ROM_SIZE + NB_CHAR_ROM_SIZE;

/** Little-endian RGBA: lit dot / dark dot. */
export const NB_INK = 0xffe6e6e6;
export const NB_PAPER = 0xff000000;
