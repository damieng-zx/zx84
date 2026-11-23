/**
 * Oric-1 / Oric Atmos hardware constants.
 *
 * The Oric is a 6502 machine with a single custom chip doing the video, the
 * memory timing and the address decode: the ULA (`HCS10017`). Everything that
 * is not the 6502, the 6522 VIA or the AY-3-8912 lives in there.
 *
 * Facts here come from the Oric hardware programming reference
 * (oric.free.fr/programming.html), Mike Brown's ULA guide and MAME's
 * `tangerine/oric.cpp`.
 */

/** The 6502 runs at 1 MHz (a 12 MHz crystal divided by 12). The clock the ULA
 *  hands the CPU is asymmetric — it takes more than half of each cycle — so the
 *  effective throughput is nearer 1.5 MHz-equivalent, but one instruction
 *  cycle is one t-state and that is what the frame grid counts. */
export const ORIC_CPU_CLOCK = 1_000_000;

/** 64 CPU cycles a scanline (one column of the display is 1 microsecond). */
export const ORIC_CYCLES_PER_LINE = 64;
/** 312 lines a frame in 50 Hz mode; 260 in 60 Hz mode (a ULA attribute per
 *  line chooses, and the ROM sets it once). */
export const ORIC_LINES_PER_FRAME = 312;
export const ORIC_TSTATES_PER_FRAME = ORIC_CYCLES_PER_LINE * ORIC_LINES_PER_FRAME;
export const ORIC_FRAME_HZ = ORIC_CPU_CLOCK / ORIC_TSTATES_PER_FRAME;
export const ORIC_FRAME_HZ_60 = ORIC_CPU_CLOCK / (ORIC_CYCLES_PER_LINE * 260);

/** The PSG is clocked from the same 12 MHz crystal, divided by 12. */
export const ORIC_PSG_CLOCK = 1_000_000;

// ── The display ────────────────────────────────────────────────────────────
/** The ULA shows 240x224 (40 columns of 6-pixel cells by 28 rows of 8). */
export const ORIC_ACTIVE_WIDTH = 240;
export const ORIC_ACTIVE_HEIGHT = 224;
/** Border either side of the active area, in buffer pixels. */
export const ORIC_BORDER_LEFT = 32;
export const ORIC_BORDER_TOP = 32;
export const ORIC_SCREEN_WIDTH = ORIC_ACTIVE_WIDTH + ORIC_BORDER_LEFT * 2;
export const ORIC_SCREEN_HEIGHT = ORIC_ACTIVE_HEIGHT + ORIC_BORDER_TOP * 2;
/**
 * Square pixels: the framebuffer is displayed 1:1, one emulator pixel to one
 * device pixel at every scale step.
 *
 * A real Oric pixel is 5:4, and stretching the CSS box by 1.25 to reproduce that
 * costs exact pixel mapping — the horizontal axis lands on fractional device
 * pixels, so nearest-neighbour duplicates every fourth column. Square pixels are
 * the deliberate trade: the picture is slightly narrower than a real TV's, but
 * every pixel is crisp and evenly sized, which is what this machine's display
 * setting exists to guarantee.
 */
export const ORIC_PIXEL_ASPECT_X = 1;

/** Text screen geometry: 40 columns by 28 rows, one byte a cell. */
export const ORIC_TEXT_COLS = 40;
export const ORIC_TEXT_ROWS = 28;
/** Character cell, in buffer pixels. */
export const ORIC_CELL_WIDTH = 6;
export const ORIC_CELL_HEIGHT = 8;

// ── The memory map ─────────────────────────────────────────────────────────
export const ORIC_RAM_BASE = 0x0000;
export const ORIC_RAM_END = 0xC000;
/** Everything in page 3 is I/O: the VIA is mirrored across it, and a fitted
 *  card takes the registers it wants. */
export const ORIC_IO_BASE = 0x0300;
export const ORIC_IO_END = 0x0400;

/** The hires screen: 200 lines of 40 bytes. */
export const ORIC_HIRES_SCREEN = 0xA000;
export const ORIC_HIRES_LINES = 200;
/** The text screen: 28 rows of 40 bytes, right after the hires area's tail. */
export const ORIC_TEXT_SCREEN = 0xBB80;
/** Where the ULA starts reading text rows once hires stops at line 200. Text
 *  address arithmetic runs straight on through, so this is `$BB80 + 25 * 40`. */
export const ORIC_TEXT_TAIL = 0xBF68;
/** The ULA forces text from this line on, whatever the mode attribute says. */
export const ORIC_HIRES_LAST_LINE = 200;

/** Character set bases: $B400 standard / $B800 alternate in text mode, $9800 /
 *  $9C00 in hires (the same glyphs at two addresses). */
export const ORIC_CHARSET_TEXT = 0xB400;
export const ORIC_CHARSET_TEXT_ALT = 0xB800;
export const ORIC_CHARSET_HIRES = 0x9800;
export const ORIC_CHARSET_HIRES_ALT = 0x9C00;
/** 96 printable glyphs of 8 bytes. */
export const ORIC_CHARSET_GLYPHS = 96;
export const ORIC_CHARSET_SIZE = ORIC_CHARSET_GLYPHS * 8;
export const ORIC_FIRST_PRINTABLE = 0x20;
export const ORIC_LAST_PRINTABLE = 0x7F;

/** The 16 KB BASIC/OS ROM at $C000, and the 16 KB overlay RAM behind it. */
export const ORIC_ROM_BASE = 0xC000;
export const ORIC_ROM_SIZE = 0x4000;
/** The overlay RAM window shares the ROM's addresses. */
export const ORIC_OVERLAY_BASE = 0xC000;

/** The eight ULA colours, one bit each of red, green and blue, as the renderer's
 *  ABGR words. There is no palette register: this is the whole palette. */
export const ORIC_PALETTE = Uint32Array.from([
  0xFF000000, // 0 black
  0xFF0000FF, // 1 red
  0xFF00FF00, // 2 green
  0xFF00FFFF, // 3 yellow
  0xFFFF0000, // 4 blue
  0xFFFF00FF, // 5 magenta
  0xFFFFFF00, // 6 cyan
  0xFFFFFFFF, // 7 white
]);

/** Ink and paper at the start of every line: white on black. */
export const ORIC_RESET_INK = 7;
export const ORIC_RESET_PAPER = 0;

// ── The VIA ────────────────────────────────────────────────────────────────
/** The VIA is always selected by a page-3 address; its 16 registers are
 *  mirrored across the page. The core masks the register itself, so this is
 *  belt-and-braces at the machine layer — but it also names the width the page
 *  decode relies on, so it stays. */
export const ORIC_VIA_MASK = 0x0F;
/** Port B bits used by the keyboard. */
export const ORIC_KBD_ROW_MASK = 0x07;
export const ORIC_KBD_SENSE = 0x08;
/** Port B bits used by the cassette and the printer. */
export const ORIC_TAPE_MOTOR = 0x40;
export const ORIC_TAPE_OUT = 0x80;
export const ORIC_PRINTER_STROBE = 0x10;

// ── The PSG, hanging off VIA port A ───────────────────────────────────────
/** AY-3-8912 register 7 is the mixer; bits 6-7 set port A's direction
 *  (1 = input). The keyboard needs port A as an input. */
export const ORIC_PSG_MIXER = 7;
export const ORIC_PSG_PORT_A = 14;
export const ORIC_PSG_PORT_A_INPUT = 0x40;
/** 8x8 keyboard matrix: eight columns (this PSG port) by eight rows. */
export const ORIC_KBD_COLS = 8;
export const ORIC_KBD_ROWS = 8;

// ── The system ROMs ───────────────────────────────────────────────────────
/** BASIC 1.1b is the Atmos ROM; BASIC 1.0 the Oric-1's. Both are 16 KB. */
export const ORIC_SYSTEM_ROM_LABEL = 'System ROM (BASIC + OS)';
