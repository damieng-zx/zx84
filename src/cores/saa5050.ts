/**
 * Mullard SAA5050 teletext character generator (Mode 7).
 *
 * A commodity teletext chip: it turns a stream of 7-bit display bytes into
 * character cells with alpha or mosaic glyphs. Control codes (0x00-0x1F)
 * update the foreground/background colour and select alpha vs mosaic, with the
 * state carrying left-to-right within a row and on into the next row.
 *
 * The chip's native cell is 6 dots x 10 lines. The BBC's video hardware
 * doubles this to 12 x 20, and the SAA5050 rounds diagonal lines by inserting
 * half-dots, so this core emits the final 12 x 20 bitmap (bit 0 = leftmost
 * column). The owning machine reads the display bytes (via the 6845's MA) and
 * calls `renderRow`; the chip never touches memory.
 */

import { SAA5050_FONT, SAA5050_GLYPH_ROWS } from './saa5050-font.ts';

/** One rendered teletext cell: 20 scanline rows at the doubled resolution,
 *  each a 12-bit pixel pattern (bit 0 = leftmost column). */
export interface Saa5050Cell {
  readonly pixels: Uint16Array;
  fg: number;
  bg: number;
}

export function createSaa5050Cells(count: number): Saa5050Cell[] {
  return Array.from({ length: count }, () => ({ pixels: new Uint16Array(20), fg: 7, bg: 0 }));
}

export class Saa5050 {
  private fg = 7;
  private bg = 0;
  private graphics = false;
  private separated = false;
  private hold = false;
  private holdChar = 0x20;
  /** Apply the character rounding. Off emits the plain doubled dots, for a
   *  display stage that does the rounding itself (the SAA5050 upscaler). */
  rounding = true;
  /** Reused 6x10 mosaic scratch (6-bit rows). */
  private readonly mosaic6 = new Uint8Array(10);

  reset(): void {
    this.fg = 7;
    this.bg = 0;
    this.graphics = false;
    this.separated = false;
    this.hold = false;
    this.holdChar = 0x20;
  }

  /** Expand a 5-bit glyph row to the doubled 10-bit pattern (bit 0 = left). */
  private static expand5(v: number): number {
    let c = 0;
    for (let i = 0; i < 5; i++) if (v & (1 << i)) c |= 3 << (2 * i);
    return c;
  }

  /** Expand a 6-dot row to the doubled 12-bit pattern. */
  private static expand6(v: number): number {
    let c = 0;
    for (let i = 0; i < 6; i++) if (v & (1 << i)) c |= 3 << (2 * i);
    return c;
  }

  /** SAA5050 character rounding: where diagonal neighbours meet, fill the
   *  intervening half-dot (operates on two doubled rows). */
  static characterRounding(a: number, b: number): number {
    return a | ((a >> 1) & b & ~(b >> 1)) | ((a << 1) & b & ~(b << 1));
  }

  private applyControl(c: number): void {
    if (c >= 0x1C) {
      switch (c) {
        case 0x1C: this.bg = 0; break;          // black background
        case 0x1D: this.bg = this.fg; break;    // new background
        case 0x1E: this.hold = true; break;     // hold mosaics
        case 0x1F: this.hold = false; break;    // release mosaics
      }
      return;
    }
    this.fg = c & 7;
    this.graphics = (c & 0x08) !== 0;
    this.separated = (c & 0x10) !== 0;
  }

  /** Alpha glyph: the 5x9 shape, doubled and diagonally rounded to 12x20. */
  private alpha(code: number, pixels: Uint16Array): void {
    const base = (code - 0x20) * SAA5050_GLYPH_ROWS;
    const row = (r: number): number =>
      (r >= 0 && r < SAA5050_GLYPH_ROWS) ? (SAA5050_FONT[base + r] & 0x1F) : 0;
    for (let ra = 0; ra < 20; ra++) {
      const a = Saa5050.expand5(row(ra >> 1));
      const b = Saa5050.expand5(row((ra + ((ra & 1) ? 1 : -1)) >> 1));
      pixels[ra] = (this.rounding ? Saa5050.characterRounding(a, b) : a) & 0xFFF;
    }
  }

  /** 2x3 mosaic: bits 0/1 top, 2/3 middle, 4/5 bottom (left/right). */
  private mosaic(bits: number, pixels: Uint16Array, separated: boolean): void {
    const rows = this.mosaic6;
    rows.fill(0);
    // Block row spans in the 10-line cell; separated mosaics leave a one-line
    // gap between rows and shrink each block by a dot on its inner edge.
    const rowSpans: readonly (readonly [number, number])[] = separated
      ? [[0, 2], [3, 6], [7, 9]]
      : [[0, 3], [3, 7], [7, 10]];
    const colSpans: readonly (readonly [number, number])[] = separated
      ? [[0, 2], [4, 6]]
      : [[0, 3], [3, 6]];
    for (let by = 0; by < 3; by++) {
      const [y0, y1] = rowSpans[by];
      for (let bx = 0; bx < 2; bx++) {
        if ((bits & (1 << (by * 2 + bx))) === 0) continue;
        const [x0, x1] = colSpans[bx];
        for (let y = y0; y < y1; y++) {
          let r = rows[y];
          for (let x = x0; x < x1; x++) r |= 1 << x;
          rows[y] = r;
        }
      }
    }
    for (let ra = 0; ra < 20; ra++) pixels[ra] = Saa5050.expand6(rows[ra >> 1]);
  }

  /**
   * Decode one teletext row of `count` display bytes into `out`. The cell array
   * (and its pixel buffers) is preallocated by the machine and reused.
   */
  renderRow(chars: Uint8Array, count: number, out: Saa5050Cell[]): void {
    for (let i = 0; i < count; i++) {
      const c = chars[i] & 0x7F;
      const cell = out[i];
      if (c < 0x20) {
        this.applyControl(c);
        cell.fg = this.fg;
        cell.bg = this.bg;
        cell.pixels.fill(0);
        continue;
      }
      cell.fg = this.fg;
      cell.bg = this.bg;
      if (this.graphics) {
        if (c === 0x20 && !this.hold) { cell.pixels.fill(0); continue; }
        const bits = c === 0x20 ? this.holdChar : c;
        if (c !== 0x20) this.holdChar = c;
        this.mosaic(bits, cell.pixels, this.separated);
      } else {
        this.alpha(c, cell.pixels);
      }
    }
  }
}
