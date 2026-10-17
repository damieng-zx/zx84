/**
 * Apple II video output: text, lores, hires and the mixed modes, drawn into a
 * 280×192 active area inside a black border.
 *
 * The renderer reads display RAM directly by address — text and lores share the
 * $400/$800 pages with their interleaved row/column addressing, hires uses the
 * $2000/$4000 pages with the 8-line-interleaved layout — and takes the mode
 * switches (text/mixed/page2/hires) from the machine. Hires colour is the NTSC
 * artifact model: two adjacent lit dots read white, a lone dot reads green/
 * violet or orange/blue depending on the byte's high ("shift") bit.
 */

import { APPLE2_BORDER_LEFT, APPLE2_BORDER_TOP, APPLE2_SCREEN_WIDTH, APPLE2_SCREEN_HEIGHT } from './constants.ts';
import type { Apple2Charset } from './apple2-charset.ts';

const W = APPLE2_SCREEN_WIDTH;
const H = APPLE2_SCREEN_HEIGHT;
const ACTIVE_X = APPLE2_BORDER_LEFT;
const ACTIVE_Y = APPLE2_BORDER_TOP;

/** Packed little-endian RGBA (0xAABBGGRR), matching the rest of the codebase. */
const BLACK = 0xFF000000;
const WHITE = 0xFFFFFFFF;
const GREEN = 0xFF00DD11;
const VIOLET = 0xFFFF44FF;
const ORANGE = 0xFF0066FF;
const BLUE = 0xFFFFAA22;

/** The 16 lores colours (Apple II NTSC), packed. */
const LORES = Uint32Array.from([
  0xFF000000, 0xFFAA22DD, 0xFFCC3366, 0xFFFF44FF,
  0xFF227700, 0xFF888888, 0xFFFFAA22, 0xFFFFDD66,
  0xFF004488, 0xFF0066FF, 0xFFAAAAAA, 0xFF99AAFF,
  0xFF00DD11, 0xFF00EEFF, 0xFFAAFF44, 0xFFFFFFFF,
]);

/** Artifact colour by (prevBit<<1)|bit, for the two shift phases. */
const HIRES_PHASE0 = Uint32Array.from([BLACK, GREEN, VIOLET, WHITE]);
const HIRES_PHASE1 = Uint32Array.from([BLACK, ORANGE, BLUE, WHITE]);

export interface Apple2VideoState {
  ram: Uint8Array;
  textMode: boolean;
  mixed: boolean;
  page2: boolean;
  hires: boolean;
  charset: Apple2Charset;
  flashPhase: boolean;
}

/** Address of the first byte of text/lores row `row` on the given page. */
export function textRowBase(page: 'page1' | 'page2', row: number): number {
  const base = page === 'page2' ? 0x800 : 0x400;
  return base + (row & 7) * 0x80 + (row >> 3) * 0x28;
}

/** Address of the first byte of hires scanline `y` on the given page. */
export function hiresRowBase(page: 'page1' | 'page2', y: number): number {
  const base = page === 'page2' ? 0x4000 : 0x2000;
  return base + (y & 7) * 0x400 + ((y >> 3) & 7) * 0x80 + (y >> 6) * 0x28;
}

export class Apple2Video {
  readonly width = W;
  readonly height = H;
  readonly pixels = new Uint8Array(W * H * 4);
  private readonly pixels32 = new Uint32Array(this.pixels.buffer);

  reset(): void {
    this.pixels32.fill(BLACK);
  }

  render(s: Apple2VideoState): void {
    const px = this.pixels32;
    px.fill(BLACK);
    if (s.textMode) {
      this.textRows(s, 0, 24);
      return;
    }
    if (s.hires) this.hires(s);
    else this.lores(s);
    if (s.mixed) this.textRows(s, 20, 4);
  }

  /** Text rows [start, start+count) into the active area. */
  private textRows(s: Apple2VideoState, start: number, count: number): void {
    const px = this.pixels32;
    const page = s.page2 ? 'page2' : 'page1';
    for (let row = start; row < start + count; row++) {
      const addr = textRowBase(page, row);
      const y0 = ACTIVE_Y + row * 8;
      for (let col = 0; col < 40; col++) {
        const b = s.ram[(addr + col) & 0xFFFF];
        const code = b & 0x3F;
        // Attributes are in the top two bits: $80-$FF normal, $40-$7F
        // flashing (alternating normal/inverse), $00-$3F inverse. The glyph is
        // always the low six bits.
        const hi = b & 0xC0;
        const inverse = hi === 0x00 || (hi === 0x40 && s.flashPhase);
        const x0 = ACTIVE_X + col * 7;
        for (let r = 0; r < 8; r++) {
          const bits = s.charset.glyphRow(code, r);
          const out = (y0 + r) * W;
          for (let x = 0; x < 7; x++) {
            const on = (bits >> (6 - x)) & 1;
            px[out + x0 + x] = (on ^ (inverse ? 1 : 0)) ? WHITE : BLACK;
          }
        }
      }
    }
  }

  /** Lores: 40×48 blocks, each 7×4 pixels; the byte's nibbles are two blocks. */
  private lores(s: Apple2VideoState): void {
    const px = this.pixels32;
    const page = s.page2 ? 'page2' : 'page1';
    for (let br = 0; br < 48; br++) {
      const trow = br >> 1;
      const addr = textRowBase(page, trow);
      const y0 = ACTIVE_Y + br * 4;
      const high = (br & 1) === 1;
      for (let col = 0; col < 40; col++) {
        const b = s.ram[(addr + col) & 0xFFFF];
        const pen = (high ? (b >> 4) : b) & 0x0F;
        const colour = LORES[pen];
        const x0 = ACTIVE_X + col * 7;
        for (let y = 0; y < 4; y++) {
          const out = (y0 + y) * W;
          px.fill(colour, out + x0, out + x0 + 7);
        }
      }
    }
  }

  /** Hires: 280×192, seven pixels per byte, NTSC artifact colour. */
  private hires(s: Apple2VideoState): void {
    const px = this.pixels32;
    const page = s.page2 ? 'page2' : 'page1';
    for (let y = 0; y < 192; y++) {
      const addr = hiresRowBase(page, y);
      const out = (ACTIVE_Y + y) * W + ACTIVE_X;
      let prev = 0;
      for (let col = 0; col < 40; col++) {
        const b = s.ram[(addr + col) & 0xFFFF];
        const table = (b & 0x80) !== 0 ? HIRES_PHASE1 : HIRES_PHASE0;
        // Bits 0-6 are the seven pixels, bit 0 leftmost (the HPLOT mask table
        // in the ROM confirms it: plotting x=0 sets bit 0); bit 7 is the
        // half-dot colour-phase delay, not a pixel.
        for (let i = 0; i < 7; i++) {
          const bit = (b >> i) & 1;
          px[out + col * 7 + i] = table[(prev << 1) | bit];
          prev = bit;
        }
      }
    }
  }
}
