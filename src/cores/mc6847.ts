/**
 * Motorola MC6847 Video Display Generator (VDG).
 *
 * A commodity chip (Acorn Atom, TRS-80 Colour Computer, Dragon, MC-10, Colour
 * Genie): 256x192 pixels from a display RAM the chip addresses itself, with
 * alphanumeric, semigraphic and eight graphics modes. The mode pins (A/G,
 * GM0-2, CSS) and the per-character pins (AS, INTEXT, INV) are set by the
 * owning machine; the Atom wires the character pins to bits 6 and 7 of each
 * fetched byte.
 *
 * The chip reads its display RAM linearly: a row of `bytesPerRow` bytes is
 * fetched once and the VDG repeats it for `linesPerRow` scanlines. The core
 * draws one whole 256x192 field from a caller-supplied RAM view; the machine
 * owns the border and the frame buffer geometry.
 *
 * Palette slots follow the 6847 datasheet, and a machine may override the
 * 16-entry table (`palette`):
 *   0-7   graphics/semigraphic colours (CSS bank 0, then CSS bank 1)
 *   8-11  two-colour graphics (CSS 0: 8/9, CSS 1: 10/11)
 *   12-15 alphanumeric (CSS 0: 12/13, CSS 1: 14/15)
 * The default table is the Motorola part's colours. Packed words are the
 * renderer's little-endian RGBA (A<<24 | B<<16 | G<<8 | R).
 */

import type { StateSink, StateSource } from '@/utils/state-stream.ts';
import { MC6847_FONT } from './mc6847-font.ts';

/** Re-exported so a machine (and the OCR/tests) can reach the chip's built-in
 *  character generator without a second import path. */
export { MC6847_FONT } from './mc6847-font.ts';

/** Active display geometry. */
export const MC6847_WIDTH = 256;
export const MC6847_HEIGHT = 192;
/** Display RAM the chip can address: 6 KB on a fully expanded Atom. */
export const MC6847_VRAM_SIZE = 0x1800;

/** Pack an 8-bit-per-channel colour as the renderer's RGBA word. */
export function mc6847Colour(r: number, g: number, b: number): number {
  return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
}

/** The Motorola MC6847's own sixteen-entry palette. */
export const MC6847_PALETTE: readonly number[] = [
  // 0-7: green, yellow, blue, red, buff, cyan, magenta, orange
  mc6847Colour(0x30, 0xd2, 0x00), mc6847Colour(0xc1, 0xe5, 0x00),
  mc6847Colour(0x4c, 0x3a, 0xb4), mc6847Colour(0x9a, 0x32, 0x36),
  mc6847Colour(0xbf, 0xc8, 0xad), mc6847Colour(0x41, 0xaf, 0x71),
  mc6847Colour(0xc8, 0x4e, 0xf0), mc6847Colour(0xd4, 0x7f, 0x00),
  // 8-11: two-colour graphics: black/green, black/buff
  mc6847Colour(0x26, 0x30, 0x16), mc6847Colour(0x30, 0xd2, 0x00),
  mc6847Colour(0x26, 0x30, 0x16), mc6847Colour(0xbf, 0xc8, 0xad),
  // 12-15: alphanumeric: dark/bright green, dark/bright orange
  mc6847Colour(0x00, 0x7c, 0x00), mc6847Colour(0x30, 0xd2, 0x00),
  mc6847Colour(0x6b, 0x27, 0x00), mc6847Colour(0xff, 0xb7, 0x00),
];

/** One graphics mode's fetch/expansion geometry. */
interface GraphicsMode {
  readonly bytesPerRow: number;
  readonly linesPerRow: number;
  readonly bitsPerPixel: 1 | 2;
}

/** GM2 GM1 GM0 -> geometry (A/G = 1). */
const GRAPHICS_MODES: readonly GraphicsMode[] = [
  { bytesPerRow: 16, linesPerRow: 3, bitsPerPixel: 2 }, // CG1 64x64x4
  { bytesPerRow: 16, linesPerRow: 3, bitsPerPixel: 1 }, // RG1 128x64x2
  { bytesPerRow: 32, linesPerRow: 3, bitsPerPixel: 2 }, // CG2 128x64x4
  { bytesPerRow: 16, linesPerRow: 2, bitsPerPixel: 1 }, // RG2 128x96x2
  { bytesPerRow: 32, linesPerRow: 2, bitsPerPixel: 2 }, // CG3 128x96x4
  { bytesPerRow: 16, linesPerRow: 1, bitsPerPixel: 1 }, // RG3 128x192x2
  { bytesPerRow: 32, linesPerRow: 1, bitsPerPixel: 2 }, // CG6 128x192x4
  { bytesPerRow: 32, linesPerRow: 1, bitsPerPixel: 1 }, // RG6 256x192x2
];

const GRAPHICS_NAMES: readonly string[] = [
  '64x64 4-colour', '128x64 2-colour', '128x64 4-colour', '128x96 2-colour',
  '128x96 4-colour', '128x192 2-colour', '128x192 4-colour', '256x192 2-colour',
];

/** Small packed pin set for `dataPins`: AS, INTEXT, INV. */
export const MC6847_PIN_AS = 0x01;
export const MC6847_PIN_INTEXT = 0x02;
export const MC6847_PIN_INV = 0x04;

export class Mc6847 {
  // Mode pins.
  ag = false;
  gm0 = false;
  gm1 = false;
  gm2 = false;
  css = false;
  // Character pins, used when `dataPins` is null.
  as = false;
  intext = false;
  inv = false;

  /** Per-byte character pins for machines that wire bits of the data bus to
   *  AS/INTEXT/INV (the Atom: bit 6 to both, bit 7 to INV). Returns the packed
   *  MC6847_PIN_* bits. */
  dataPins: ((byte: number) => number) | null = null;

  /** Sixteen RGBA palette entries; see the class comment. */
  readonly palette = Uint32Array.from(MC6847_PALETTE);

  /** GM2..GM0 as a 0-7 graphics-mode number. */
  get gm(): number { return (this.gm2 ? 4 : 0) | (this.gm1 ? 2 : 0) | (this.gm0 ? 1 : 0); }

  get graphics(): boolean { return this.ag; }

  /** The mode's human name, for the debugger/status readout. */
  get modeName(): string { return this.ag ? GRAPHICS_NAMES[this.gm] : 'text 32x16'; }

  /** Bytes fetched per display row in the current mode. */
  get bytesPerRow(): number { return this.ag ? GRAPHICS_MODES[this.gm].bytesPerRow : 32; }

  /** Scanlines each fetched row is displayed for. */
  get linesPerRow(): number { return this.ag ? GRAPHICS_MODES[this.gm].linesPerRow : 12; }

  /** Pixels across the active field (64-256; always drawn into 256). */
  get pixelsWide(): number {
    if (!this.ag) return 32 * 8;
    const m = GRAPHICS_MODES[this.gm];
    return m.bytesPerRow * (8 / m.bitsPerPixel);
  }

  /** Set the mode pins from an 8-bit register the way the Atom wires them:
   *  port A bit 4 = A/G, bits 5-7 = GM0-GM2. */
  setAtomModeBits(value: number): void {
    this.ag = (value & 0x10) !== 0;
    this.gm0 = (value & 0x20) !== 0;
    this.gm1 = (value & 0x40) !== 0;
    this.gm2 = (value & 0x80) !== 0;
  }

  /** The Atom's per-byte pins: bit 6 drives AS and INTEXT, bit 7 drives INV. */
  static atomDataPins(byte: number): number {
    return (byte & 0x40 ? MC6847_PIN_AS | MC6847_PIN_INTEXT : 0) | (byte & 0x80 ? MC6847_PIN_INV : 0);
  }

  reset(): void {
    this.ag = this.gm0 = this.gm1 = this.gm2 = false;
    this.css = this.as = this.intext = this.inv = false;
  }

  /**
   * Draw the 256x192 active field into `out` at (x0, y0), with `stride` pixels
   * between buffer rows. `vram` is the chip's display RAM view (at least the
   * mode's fetched bytes; 6 KB wraps). The caller paints the border.
   */
  render(vram: Uint8Array, out: Uint32Array, stride: number, x0: number, y0: number): void {
    const palette = this.palette;
    if (!this.ag) {
      this.renderText(vram, out, stride, x0, y0, palette);
      return;
    }
    const mode = GRAPHICS_MODES[this.gm];
    const { bytesPerRow, linesPerRow, bitsPerPixel } = mode;
    const pixelsPerByte = 8 / bitsPerPixel;
    const pixelWidth = 256 / (bytesPerRow * pixelsPerByte);
    const colorBase = bitsPerPixel === 2 ? (this.css ? 4 : 0) : (this.css ? 10 : 8);
    const mask = bitsPerPixel === 2 ? 3 : 1;
    const vramLen = vram.length;

    for (let y = 0; y < MC6847_HEIGHT; y++) {
      const row = (y / linesPerRow) | 0;
      const base = row * bytesPerRow;
      const dest = (y0 + y) * stride + x0;
      for (let c = 0; c < bytesPerRow; c++) {
        const data = vram[(base + c) % vramLen];
        let x = dest + c * pixelsPerByte * pixelWidth;
        for (let j = 0; j < pixelsPerByte; j++) {
          const shift = 8 - (j + 1) * bitsPerPixel;
          const colour = palette[colorBase + ((data >> shift) & mask)];
          for (let k = 0; k < pixelWidth; k++) out[x + k] = colour;
          x += pixelWidth;
        }
      }
    }
  }

  private renderText(
    vram: Uint8Array, out: Uint32Array, stride: number, x0: number, y0: number, palette: Uint32Array,
  ): void {
    const vramLen = vram.length;
    const textFg = this.css ? 15 : 13;
    const textBg = this.css ? 14 : 12;
    // The VDG fetches one row of 32 bytes per 12 scanlines; the character
    // generator repeats the glyph row `sub` of the cell.
    for (let y = 0; y < MC6847_HEIGHT; y++) {
      const row = (y / 12) | 0;
      const sub = y % 12;
      const base = row * 32;
      const dest = (y0 + y) * stride + x0;
      for (let c = 0; c < 32; c++) {
        const data = vram[(base + c) % vramLen];
        const pins = this.dataPins !== null ? this.dataPins(data)
          : ((this.as ? MC6847_PIN_AS : 0) | (this.intext ? MC6847_PIN_INTEXT : 0)
            | (this.inv ? MC6847_PIN_INV : 0));
        const x = dest + c * 8;
        if ((pins & MC6847_PIN_AS) !== 0) {
          if ((pins & MC6847_PIN_INTEXT) !== 0) this.drawSemigraphics6(data, sub, out, x, palette);
          else this.drawSemigraphics4(data, sub, out, x, palette);
          continue;
        }
        if ((pins & MC6847_PIN_INTEXT) !== 0) {
          // The chip's "stripe" test pattern (INTEXT with no external ROM).
          const stripe = (~data) & 0x7F;
          const reverse = (pins & MC6847_PIN_INV) !== 0;
          const fg = reverse ? textBg : textFg;
          const bg = reverse ? textFg : textBg;
          for (let bit = 0; bit < 8; bit++) {
            out[x + bit] = (stripe & (0x80 >> bit)) ? palette[fg] : palette[bg];
          }
          continue;
        }
        const glyph = (data & 0x3F) * 12 + sub;
        let bits = MC6847_FONT[glyph];
        if ((pins & MC6847_PIN_INV) !== 0) bits ^= 0xFF;
        for (let bit = 0; bit < 8; bit++) {
          out[x + bit] = (bits & (0x80 >> bit)) ? palette[textFg] : palette[textBg];
        }
      }
    }
  }

  /** Semigraphics 6: a 2x3 grid of 4x4-dot blocks, colour from bits 6-7. */
  private drawSemigraphics6(data: number, sub: number, out: Uint32Array, x: number, palette: Uint32Array): void {
    const blockRow = (11 - sub) >> 2; // 2 top, 1 middle, 0 bottom
    const left = (data >> (blockRow * 2 + 1)) & 1;
    const right = (data >> (blockRow * 2)) & 1;
    const colour = palette[(this.css ? 4 : 0) + ((data >> 6) & 3)];
    const background = palette[8];
    for (let bit = 0; bit < 4; bit++) out[x + bit] = left ? colour : background;
    for (let bit = 4; bit < 8; bit++) out[x + bit] = right ? colour : background;
  }

  /** Semigraphics 4: a 2x2 grid of 4x6-dot blocks, colour from bits 4-6. */
  private drawSemigraphics4(data: number, sub: number, out: Uint32Array, x: number, palette: Uint32Array): void {
    const blockRow = sub < 6 ? 1 : 0;
    const left = (data >> (blockRow * 2 + 1)) & 1;
    const right = (data >> (blockRow * 2)) & 1;
    const colour = palette[(data >> 4) & 0x07];
    const background = palette[8];
    for (let bit = 0; bit < 4; bit++) out[x + bit] = left ? colour : background;
    for (let bit = 4; bit < 8; bit++) out[x + bit] = right ? colour : background;
  }

  saveState(w: StateSink): void {
    w.bool(this.ag); w.bool(this.gm0); w.bool(this.gm1); w.bool(this.gm2);
    w.bool(this.css); w.bool(this.as); w.bool(this.intext); w.bool(this.inv);
  }

  loadState(r: StateSource): void {
    this.ag = r.bool(); this.gm0 = r.bool(); this.gm1 = r.bool(); this.gm2 = r.bool();
    this.css = r.bool(); this.as = r.bool(); this.intext = r.bool(); this.inv = r.bool();
  }
}
