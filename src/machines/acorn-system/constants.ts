/**
 * Acorn System 2 hardware constants.
 *
 * The System 2 is a 1 MHz 6502 on the Acorn 6502 CPU card (200,000) in a 3U
 * Eurocard frame: 1K of static RAM and an INS8154 on the CPU card, an 8K
 * RAM + 8K ROM card carrying the resident 4K BASIC, and the 40x25 teletext VDU
 * card (MC6845 + SAA5050). There is no floppy controller — that is what makes a
 * System 3 — and no sound.
 */

/** The CPU card runs a 1 MHz crystal. */
export const ACORN_SYSTEM_CPU_CLOCK = 1_000_000;

/** A line of the 625-line/50 Hz field is 64 microseconds: 64 cycles at 1 MHz. */
export const ACORN_SYSTEM_CYCLES_PER_LINE = 64;
/** 312 lines make the field: (R4+1) x 10 rasters + R5 from the COS's CRTC table. */
export const ACORN_SYSTEM_LINES_PER_FRAME = 312;
export const ACORN_SYSTEM_TSTATES_PER_FRAME =
  ACORN_SYSTEM_CYCLES_PER_LINE * ACORN_SYSTEM_LINES_PER_FRAME;
export const ACORN_SYSTEM_FRAME_HZ =
  ACORN_SYSTEM_CPU_CLOCK / ACORN_SYSTEM_TSTATES_PER_FRAME;

/*
 * The teletext card holds exactly 40x25 characters in 1K of character RAM.
 * The SAA5050's cell is 6 dots wide by 10 lines tall, and the chip rounds
 * diagonals at twice that width, so a cell is drawn as 12 x 10 dots here —
 * one buffer line per scanline, the same shape the BBC's Mode 7 uses.
 */
export const ACORN_SYSTEM_COLS = 40;
export const ACORN_SYSTEM_ROWS = 25;
export const ACORN_SYSTEM_CELL_WIDTH = 12;
export const ACORN_SYSTEM_CELL_HEIGHT = 10;
export const ACORN_SYSTEM_ACTIVE_WIDTH = ACORN_SYSTEM_COLS * ACORN_SYSTEM_CELL_WIDTH;
export const ACORN_SYSTEM_ACTIVE_HEIGHT = ACORN_SYSTEM_ROWS * ACORN_SYSTEM_CELL_HEIGHT;
/** A modest black margin, so the border setting has something to crop. */
export const ACORN_SYSTEM_BORDER_LEFT = 16;
export const ACORN_SYSTEM_BORDER_TOP = 8;
export const ACORN_SYSTEM_SCREEN_WIDTH =
  ACORN_SYSTEM_ACTIVE_WIDTH + ACORN_SYSTEM_BORDER_LEFT * 2;
export const ACORN_SYSTEM_SCREEN_HEIGHT =
  ACORN_SYSTEM_ACTIVE_HEIGHT + ACORN_SYSTEM_BORDER_TOP * 2;
/** 40 characters of 6 dots across a 4:3 picture: each dot is wider than a line. */
export const ACORN_SYSTEM_PIXEL_ASPECT_X =
  (ACORN_SYSTEM_ACTIVE_HEIGHT * 4 / 3) / ACORN_SYSTEM_ACTIVE_WIDTH;

/* ── Memory map (System 3/4 memory map, 40-column VDU variant) ───────────── */

/** The CPU card's 1K of static RAM. */
export const ACORN_SYSTEM_RAM_SIZE = 0x0400;
/** The teletext card's 1K character RAM, read by the CRTC's MA and written by the CPU. */
export const ACORN_SYSTEM_VRAM_BASE = 0x0400;
export const ACORN_SYSTEM_VRAM_SIZE = 0x0400;
/** MC6845: register select at +0, data at +1. */
export const ACORN_SYSTEM_CRTC_BASE = 0x0800;
/** The CPU card's INS8154: keyboard on port B, cassette on port A. */
export const ACORN_SYSTEM_PIA_BASE = 0x0E00;
/** The 8271 floppy controller card (System 3): command/status, param/result, reset, data. */
export const ACORN_SYSTEM_FDC_BASE = 0x0A00;
/** The 8K RAM + 8K ROM card: RAM at 0x2000, the 4K BASIC at 0xC000. */
export const ACORN_SYSTEM_CARD_RAM_BASE = 0x2000;
export const ACORN_SYSTEM_CARD_RAM_SIZE = 0x2000;
export const ACORN_SYSTEM_BASIC_BASE = 0xC000;
export const ACORN_SYSTEM_BASIC_SIZE = 0x1000;
/** The COS/kernel ROM sits at the top of the map: 2K at 0xF800 (a 4K DOS at 0xF000). */
export const ACORN_SYSTEM_ROM_BASE = 0xF000;
export const ACORN_SYSTEM_ROM_TOP = 0x10000;

/**
 * What an address no card claims reads as. The Acorn bus leaves the data lines
 * low when nothing drives a read, which is what the system software expects: the
 * kernel's printer path reads the (absent) VIB's control register and exits when
 * it reads 0, and the disc routines poll a (absent) 8271's status for "not busy"
 * as bit 7 clear. A floating high bus would hang both on a machine that has
 * neither card.
 */
export const ACORN_SYSTEM_OPEN_BUS = 0x00;
