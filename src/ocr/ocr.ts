/** Shared OCR types used by machine-specific recognition engines. */

/** Cell-grid configuration for OCR. */
export interface OcrConfig {
  /** Pixels per cell column (4, 5, 6, 8...). */
  cellWidth: number;
  /** Pixels per cell row (8 in practice). */
  cellHeight: number;
  cols: number;
  rows: number;
  /** Pixel x-offset of grid origin (default 0). */
  xOffset?: number;
  /** Pixel y-offset of grid origin (default 0). */
  yOffset?: number;
  /** The pixels are a linear hi-res bitmap (64 bytes a row, 512 pixels, no
   *  attribute file) rather than the Spectrum's interleaved 32-byte-row screen. */
  linear?: boolean;
}

/** Spectrum cell-grid presets (the heuristic detector chooses among these). The
 *  `h` grids are for the Timex 512-pixel hi-res screen: 64 columns of 8 pixels,
 *  85 of 6, 128 of 4. */
export type SpectrumOcrGrid = '32x24' | '51x24' | '64x24' | '64x24h' | '85x24h' | '128x24h';

/** CPC text grids — one per screen mode (mode 0/1/2 → 20/40/80 columns). */
export type CpcOcrGrid = '20x25' | '40x25' | '80x25';

/** Einstein text grid — 42 columns of the 6×8 system font, 24 rows. */
export type EinsteinOcrGrid = '42x24';

/** MSX text grids — SCREEN 0 is 40×24; SCREEN 1 is 32×24. */
export type MsxOcrGrid = '40x24' | '32x24';

/** PCW text grid — the displayed bitmap cut into 8x8 cells: 720x256 (90x32),
 *  or the first 200 lines (90x25) on a 60Hz machine. */
export type PcwOcrGrid = '90x32' | '90x25';

/** Lynx text grids — 6x10 cells across the active area. The 48K/96K fit 40
 *  columns in 256 pixels; the 128K's 512-pixel display fits 80. */
export type LynxOcrGrid = '40x24' | '80x24';

/** Jupiter Ace text grid — the 32x24 screen file, one byte per cell. */
export type AceOcrGrid = '32x24';

/** BBC Micro grids: Mode 7 teletext is 40×25; the bitmap modes are 20/40/80
 *  columns by 32 rows, or 25 rows in the gapped text modes 3 and 6. */
export type BbcOcrGrid = `${20 | 40 | 80}x${25 | 32}`;

/** VIC-20 grids: the VIC's own column and row counts (22×23 as the KERNAL
 *  sets them; programs choose others). */
export type Vic20OcrGrid = `${number}x${number}`;

/** Acorn Atom text grid: the 6847's 32x16 character window. */
export type AtomOcrGrid = '32x16';

/** Any grid label an OCR producer can stamp onto an OcrResult. `Vic20OcrGrid`
 *  and the C128's VDC grid are open forms: both read their column and row
 *  counts from registers, so any `WxH` a program sets is legitimate. */
export type OcrGridName =
  SpectrumOcrGrid | CpcOcrGrid | EinsteinOcrGrid | MsxOcrGrid | PcwOcrGrid
  | LynxOcrGrid | AceOcrGrid | BbcOcrGrid | Vic20OcrGrid | AtomOcrGrid;

/** A font source for OCR matching.
 *  `data` is always 768 bytes (96 chars × 8 bytes). For non-8-wide cells only
 *  `cellWidth` bits of each byte are significant.
 *
 *  `bitOffset` is the number of zero bits to the LEFT of the glyph in each
 *  font byte: 0 means glyph is MSB-aligned; a value of N means the font byte
 *  must be left-shifted by N before comparing with a screen glyph. */
export interface FontSource {
  label: string;
  data: Uint8Array;
  /** Cell width the font was authored for (defaults to 8). */
  cellWidth?: number;
  /** Glyph left-shift inside each font byte (defaults to 0 = MSB-aligned). */
  bitOffset?: number;
}

/** OCR result. */
export interface OcrResult {
  /** Plain text with newlines between rows. */
  text: string;
  /** HTML with per-cell coloured spans. */
  html: string;
  /** `cols×rows` bitmask: true = cell was matched (used to blank the framebuffer). */
  mask: boolean[];
  /** `cols×rows` per-cell paper (background) pen index, when the engine can
   *  report one for blanking matched cells. */
  paper?: number[];
  /** Grid the result was produced with. */
  grid: OcrGridName;
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
}
