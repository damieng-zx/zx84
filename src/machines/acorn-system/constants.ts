/**
 * Acorn System hardware constants.
 *
 * The four models are one backplane with different cards, so what differs is
 * data here: the CPU clock, the VDU card's geometry and address window, and
 * where the RAM and ROM cards sit (see `models.ts`, whose card sets the memory
 * class takes).
 */

/** The 6502 CPU card runs a 1 MHz crystal; the 6502A card 2 MHz. */
export const ACORN_SYSTEM_CPU_CLOCK = 1_000_000;
export const ACORN_SYSTEM_6502A_CLOCK = 2_000_000;

/** A line of the 625-line/50 Hz field is 64 microseconds. */
export const ACORN_SYSTEM_CYCLES_PER_LINE = 64;
/** 312 lines make the field: (R4+1) x 10 rasters + R5 from the DOS's CRTC table. */
export const ACORN_SYSTEM_LINES_PER_FRAME = 312;

/** T-states in a frame for a model's clock. */
export function acornSystemFrameCycles(clockHz: number): number {
  return Math.round((ACORN_SYSTEM_CYCLES_PER_LINE * clockHz) / ACORN_SYSTEM_CPU_CLOCK)
    * ACORN_SYSTEM_LINES_PER_FRAME;
}

export const ACORN_SYSTEM_TSTATES_PER_FRAME =
  ACORN_SYSTEM_CYCLES_PER_LINE * ACORN_SYSTEM_LINES_PER_FRAME;
export const ACORN_SYSTEM_FRAME_HZ =
  ACORN_SYSTEM_CPU_CLOCK / ACORN_SYSTEM_TSTATES_PER_FRAME;

/**
 * A VDU card: its character grid, its address window (character RAM and CRTC)
 * and the picture it makes.
 */
export interface AcornSystemVduConfig {
  readonly cols: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** The card's character RAM, addressed by the CRTC's MA. */
  readonly vramBase: number;
  readonly vramSize: number;
  readonly crtcBase: number;
  /** Active picture inside the frame buffer. */
  readonly activeWidth: number;
  readonly activeHeight: number;
  readonly borderLeft: number;
  readonly borderTop: number;
  readonly width: number;
  readonly height: number;
  /** 4:3 correction for the dot clock (each dot is wider than a scanline). */
  readonly pixelAspectX: number;
}

/**
 * The 40x25 teletext card: 1K of character RAM at &0400, the CRTC at &0800, and
 * an SAA5050 whose cell is 6 dots by 10 lines (drawn 12 wide, its rounded
 * output).
 */
const TELETEXT_BORDER_LEFT = 16;
const TELETEXT_BORDER_TOP = 8;
const TELETEXT_COLS = 40;
const TELETEXT_ROWS = 25;
const TELETEXT_CELL_W = 12;
const TELETEXT_CELL_H = 10;

export const TELETEXT40_VDU: AcornSystemVduConfig = {
  cols: TELETEXT_COLS,
  rows: TELETEXT_ROWS,
  cellWidth: TELETEXT_CELL_W,
  cellHeight: TELETEXT_CELL_H,
  vramBase: 0x0400,
  vramSize: 0x0400,
  crtcBase: 0x0800,
  activeWidth: TELETEXT_COLS * TELETEXT_CELL_W,
  activeHeight: TELETEXT_ROWS * TELETEXT_CELL_H,
  borderLeft: TELETEXT_BORDER_LEFT,
  borderTop: TELETEXT_BORDER_TOP,
  width: TELETEXT_COLS * TELETEXT_CELL_W + TELETEXT_BORDER_LEFT * 2,
  height: TELETEXT_ROWS * TELETEXT_CELL_H + TELETEXT_BORDER_TOP * 2,
  pixelAspectX: (TELETEXT_ROWS * TELETEXT_CELL_H * 4 / 3) / (TELETEXT_COLS * TELETEXT_CELL_W),
};

/**
 * The 80x25 character card: 2K of character RAM at &1000, the CRTC at &1840,
 * and a character-generator ROM of 8x8 glyphs clocked at 12 MHz, which gives a
 * 640-dot line. Ten scanlines per row (R9=9), so the glyph sits in the top
 * eight and the cursor uses the rest.
 */
const MONO80_BORDER_LEFT = 16;
const MONO80_BORDER_TOP = 8;
const MONO80_COLS = 80;
const MONO80_ROWS = 25;
const MONO80_CELL_W = 8;
const MONO80_CELL_H = 10;

export const MONO80_VDU: AcornSystemVduConfig = {
  cols: MONO80_COLS,
  rows: MONO80_ROWS,
  cellWidth: MONO80_CELL_W,
  cellHeight: MONO80_CELL_H,
  vramBase: 0x1000,
  vramSize: 0x0800,
  crtcBase: 0x1840,
  activeWidth: MONO80_COLS * MONO80_CELL_W,
  activeHeight: MONO80_ROWS * MONO80_CELL_H,
  borderLeft: MONO80_BORDER_LEFT,
  borderTop: MONO80_BORDER_TOP,
  width: MONO80_COLS * MONO80_CELL_W + MONO80_BORDER_LEFT * 2,
  height: MONO80_ROWS * MONO80_CELL_H + MONO80_BORDER_TOP * 2,
  pixelAspectX: (MONO80_ROWS * MONO80_CELL_H * 4 / 3) / (MONO80_COLS * MONO80_CELL_W),
};

export function acornSystemVdu(vdu: 'teletext40' | 'mono80'): AcornSystemVduConfig {
  return vdu === 'mono80' ? MONO80_VDU : TELETEXT40_VDU;
}

/** The CPU card's keyboard chip, and the 8271 card, both sit here on every model. */
export const ACORN_SYSTEM_FDC_BASE = 0x0A00;
export const ACORN_SYSTEM_PIA_BASE = 0x0E00;
/** The 8K RAM + 8K ROM card puts its BASIC PROM here. */
export const ACORN_SYSTEM_BASIC_BASE = 0xC000;
export const ACORN_SYSTEM_BASIC_SIZE = 0x1000;
