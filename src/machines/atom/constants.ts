/** Acorn Atom hardware constants. */

/** The 6502 runs at 1 MHz (a 4 MHz crystal divided by four). */
export const ATOM_CPU_CLOCK = 1_000_000;

/** 64 CPU cycles per scanline, 262 scanlines per NTSC field (the 6847's
 *  3.58 MHz clock divided by 228 dot clocks). */
export const ATOM_CYCLES_PER_LINE = 64;
export const ATOM_LINES_PER_FRAME = 262;
export const ATOM_TSTATES_PER_FRAME = ATOM_CYCLES_PER_LINE * ATOM_LINES_PER_FRAME;
/** Field rate the frame loop is paced at. */
export const ATOM_FRAME_HZ = ATOM_CPU_CLOCK / ATOM_TSTATES_PER_FRAME;

/** The 6847's active field and the bordered buffer around it. */
export const ATOM_ACTIVE_WIDTH = 256;
export const ATOM_ACTIVE_HEIGHT = 192;
export const ATOM_BORDER_LEFT = 32;
export const ATOM_BORDER_TOP = 24;
export const ATOM_SCREEN_WIDTH = ATOM_ACTIVE_WIDTH + ATOM_BORDER_LEFT * 2;
export const ATOM_SCREEN_HEIGHT = ATOM_ACTIVE_HEIGHT + ATOM_BORDER_TOP * 2;

/** A 256x192 picture on a 4:3 display: square pixels. */
export const ATOM_PIXEL_ASPECT_X = 1;

/** Text screen geometry: 32 columns by 16 rows of 8x12 cells at $8000-$81FF. */
export const ATOM_TEXT_COLS = 32;
export const ATOM_TEXT_ROWS = 16;
export const ATOM_TEXT_CELL_WIDTH = 8;
export const ATOM_TEXT_CELL_HEIGHT = 12;

/** The 6847's display RAM window ($8000-$97FF when all 6 KB is fitted). */
export const ATOM_VRAM_BASE = 0x8000;
export const ATOM_VRAM_SIZE = 0x1800;

/** The 8255 PPI and the 6522 VIA, each mirrored through its 1 KB block. */
export const ATOM_PPI_BASE = 0xB000;
export const ATOM_VIA_BASE = 0xB800;

/** ROM sockets. */
export const ATOM_BASIC_BASE = 0xC000;
export const ATOM_FLOAT_BASE = 0xD000;
export const ATOM_KERNEL_BASE = 0xF000;
export const ATOM_ROM_CHIP_SIZE = 0x1000;
/** BASIC + floating point + kernel, in the order `romSources` concatenates. */
export const ATOM_SYSTEM_ROM_SIZE = ATOM_ROM_CHIP_SIZE * 3;

/** The vertical blanking window the PPI's VSYNC input reports (low). */
export const ATOM_VBLANK_FIRST_LINE = 192;
export const ATOM_VBLANK_LAST_LINE = 223;

/** Base RAM and the everyday expansion sizes in KB. */
export const ATOM_RAM_KB_2 = 2;
export const ATOM_RAM_KB_12 = 12;
