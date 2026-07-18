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
}

/** Spectrum cell-grid presets (the heuristic detector chooses among these). */
export type SpectrumOcrGrid = '32x24' | '51x24' | '64x24';

/** CPC text grids — one per screen mode (mode 0/1/2 → 20/40/80 columns). */
export type CpcOcrGrid = '20x25' | '40x25' | '80x25';

/** Einstein text grid — 42 columns of the 6×8 system font, 24 rows. */
export type EinsteinOcrGrid = '42x24';

/** MSX text grids — SCREEN 0 is 40×24; SCREEN 1 is 32×24. */
export type MsxOcrGrid = '40x24' | '32x24';

/** Any grid label an OCR producer can stamp onto an OcrResult. */
export type OcrGridName = SpectrumOcrGrid | CpcOcrGrid | EinsteinOcrGrid | MsxOcrGrid;

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
