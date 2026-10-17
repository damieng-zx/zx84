/**
 * Apple II video output: text, lores, hires and the mixed modes, drawn into a
 * 280×192 active area inside a black border.
 *
 * The renderer reads display RAM directly by address — text and lores share the
 * $400/$800 pages with their interleaved row/column addressing, hires uses the
 * $2000/$4000 pages — and takes the mode switches (text/mixed/page2/hires) from
 * the machine.
 *
 * Colour is selectable:
 *
 *  - `mono`      the raw 1-bit picture (what a monochrome monitor shows);
 *                LORES, which has no 1-bit form, becomes its 16 luminances.
 *  - `green`     the same picture on a P1 phosphor green monitor.
 *  - `ntsc`      composite NTSC: the 1-bit sources (text and hires) are
 *                correlated against the colour subcarrier and low-passed,
 *                which is what makes the Apple II's artifact colours. A run of
 *                like pixels has no chroma and reads black or white, an
 *                alternating pattern sits exactly on the subcarrier and reads
 *                as one saturated hue, and an isolated dot leaves a fringe.
 *  - `pal`       the same decoder against the PAL dot-clock/subcarrier ratio
 *                (so patterns land on different hues) with PAL's per-line V
 *                switch and one-line chroma delay.
 */

import {
  APPLE2_BORDER_LEFT, APPLE2_BORDER_TOP, APPLE2_SCREEN_WIDTH, APPLE2_SCREEN_HEIGHT,
} from './constants.ts';
import type { Apple2Charset } from './apple2-charset.ts';

const W = APPLE2_SCREEN_WIDTH;
const H = APPLE2_SCREEN_HEIGHT;
const ACTIVE_X = APPLE2_BORDER_LEFT;
const ACTIVE_Y = APPLE2_BORDER_TOP;
const ACTIVE_W = 280;

const BLACK = 0xFF000000;
const WHITE = 0xFFFFFFFF;

/** The 16 lores colours (Apple II NTSC), packed. */
const LORES = Uint32Array.from([
  0xFF000000, 0xFFAA22DD, 0xFFCC3366, 0xFFFF44FF,
  0xFF227700, 0xFF888888, 0xFFFFAA22, 0xFFFFDD66,
  0xFF004488, 0xFF0066FF, 0xFFAAAAAA, 0xFF99AAFF,
  0xFF00DD11, 0xFF00EEFF, 0xFFAAFF44, 0xFFFFFFFF,
]);

/** Per-pen luminance (0-255) for the monochrome outputs. */
const LORES_LUMA_V = Uint8Array.from(LORES, (c) => {
  const r = c & 0xFF, g = (c >> 8) & 0xFF, b = (c >> 16) & 0xFF;
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
});
const LORES_LUMA = Uint32Array.from(LORES_LUMA_V, (y) => pack(y, y, y));
const LORES_GREEN = Uint32Array.from(LORES_LUMA_V, tintGreen);

/**
 * The four composite hues, ordered by chroma angle. The phase reference is the
 * subcarrier, and a dot in an odd column with the half-dot bit clear is green
 * (even columns give violet, and the half-dot bit swaps in the warm pair), so:
 * 0° violet, 90° blue, 180° green, 270° orange. These are the Apple II's own
 * colours, so the documented pairs come out right — "$2A $55 $2A $55" is a
 * green line, and the half-dot forms $D5/$AA are orange/blue.
 */
const HUE_RGB = [
  [0xFF, 0x44, 0xFF],
  [0x22, 0xAA, 0xFF],
  [0x11, 0xDD, 0x00],
  [0xFF, 0x66, 0x00],
] as const;

/** Chroma / luminance averaging kernel — an 8-dot triangle, roughly a decoder's
 *  chroma band-pass at the Apple II's dot rate. Even length, so a period-2
 *  pattern (an alternating colour byte) averages to exactly one half and the
 *  recovered chroma is full-scale; wide enough to blend a dithered picture and
 *  to keep PAL's off-subcarrier patterns muted rather than rainbow. */
const KERNEL = [1, 2, 3, 4, 4, 3, 2, 1].map(v => v / 20);
const KERNEL_OFF = -4;
/** Chroma magnitude of a fully alternating pattern (the saturation reference). */
const FULL_CHROMA = 0.5;

/** Subcarrier phase advanced per pixel: NTSC's dot clock is twice the
 *  subcarrier (180°), PAL's 7.125 MHz is not (≈224°). */
const NTSC_PHASE_PER_PIXEL = Math.PI;
const PAL_PHASE_PER_PIXEL = 2 * Math.PI * (4.43361875 / 7.125);

export type Apple2VideoMode = 'mono' | 'green' | 'ntsc' | 'pal';

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

export interface Apple2VideoState {
  ram: Uint8Array;
  textMode: boolean;
  mixed: boolean;
  page2: boolean;
  hires: boolean;
  charset: Apple2Charset;
  flashPhase: boolean;
  mode: Apple2VideoMode;
}

function pack(r: number, g: number, b: number): number {
  return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
}

/** A luminance 0-255 as P1 phosphor green (the classic green monitor). */
function tintGreen(y: number): number {
  return pack(((y * 0x33) / 255) | 0, ((y * 0xFF) / 255) | 0, ((y * 0x33) / 255) | 0);
}

export class Apple2Video {
  readonly width = W;
  readonly height = H;
  readonly pixels = new Uint8Array(W * H * 4);
  private readonly pixels32 = new Uint32Array(this.pixels.buffer);

  /** One 280-pixel source line: the 1-bit level and its half-dot phase flag. */
  private readonly level = new Float32Array(ACTIVE_W);
  private readonly quarter = new Uint8Array(ACTIVE_W);
  private readonly prevRe = new Float32Array(ACTIVE_W);
  private readonly prevIm = new Float32Array(ACTIVE_W);
  private prevLine = -2;

  /** Subcarrier reference tables for the active mode (rebuilt on a change). */
  private tableMode: Apple2VideoMode | null = null;
  private cosN = new Float32Array(ACTIVE_W);
  private sinN = new Float32Array(ACTIVE_W);
  private cosH = new Float32Array(ACTIVE_W);
  private sinH = new Float32Array(ACTIVE_W);

  reset(): void {
    this.pixels32.fill(BLACK);
    this.prevLine = -2;
  }

  private ensureTables(mode: Apple2VideoMode): void {
    if (this.tableMode === mode) return;
    const step = mode === 'pal' ? PAL_PHASE_PER_PIXEL : NTSC_PHASE_PER_PIXEL;
    const half = step / 2;
    // The subcarrier reference advances half a cycle (180°) per dot: the dot
    // rate is twice the subcarrier, and because a byte is seven dots (3.5
    // cycles) the phase slips 180° at every byte boundary — which is why a
    // *solid* colour line has to alternate its bytes ($2A $55 $2A $55 is 14
    // green pixels) while a single repeated byte beats green/violet per byte.
    for (let x = 0; x < ACTIVE_W; x++) {
      const p = step * x;
      this.cosN[x] = Math.cos(p);
      this.sinN[x] = Math.sin(p);
      this.cosH[x] = Math.cos(p + half);
      this.sinH[x] = Math.sin(p + half);
    }
    this.tableMode = mode;
  }

  render(s: Apple2VideoState): void {
    const px = this.pixels32;
    px.fill(BLACK);
    this.prevLine = -2;
    if (s.mode === 'ntsc' || s.mode === 'pal') this.ensureTables(s.mode);
    if (s.textMode) {
      this.textRows(s, 0, 24);
      return;
    }
    if (s.hires) this.hires(s);
    else this.lores(s);
    if (s.mixed) this.textRows(s, 20, 24);
  }

  /** Paint one 280-pixel 1-bit source line at buffer row `y`. */
  private paintLine(s: Apple2VideoState, y: number): void {
    const out = (ACTIVE_Y + y) * W + ACTIVE_X;
    const px = this.pixels32;
    if (s.mode === 'mono' || s.mode === 'green') {
      const green = s.mode === 'green';
      for (let x = 0; x < ACTIVE_W; x++) {
        const y8 = this.level[x] > 0.5 ? 255 : 0;
        px[out + x] = green ? tintGreen(y8) : (y8 ? WHITE : BLACK);
      }
      return;
    }
    const pal = s.mode === 'pal';
    const delayLine = pal && y - 1 === this.prevLine;
    for (let x = 0; x < ACTIVE_W; x++) {
      let mean = 0;
      for (let k = 0; k < KERNEL.length; k++) mean += KERNEL[k] * this.level[clampIndex(x + k + KERNEL_OFF)];
      let re = 0, im = 0;
      for (let k = 0; k < KERNEL.length; k++) {
        const xx = clampIndex(x + k + KERNEL_OFF);
        const v = (this.level[xx] - mean) * KERNEL[k];
        if (this.quarter[xx]) { re += v * this.cosH[xx]; im += v * this.sinH[xx]; }
        else { re += v * this.cosN[xx]; im += v * this.sinN[xx]; }
      }
      // PAL flips the V axis on alternate lines at the encoder and the decoder
      // flips it back, so a clean signal needs no net inversion here. What is
      // left of the delay-line decoder is the average with the previous line's
      // chroma � taken from the raw (pre-average) value so it is a one-line
      // delay, not a recursive filter.
      const rawRe = re, rawIm = im;
      if (delayLine) { re = (re + this.prevRe[x]) / 2; im = (im + this.prevIm[x]) / 2; }
      this.prevRe[x] = rawRe;
      this.prevIm[x] = rawIm;

      const mag = Math.sqrt(re * re + im * im);
      const sat = mag >= FULL_CHROMA ? 1 : mag / FULL_CHROMA;
      const lum = mean * 255;
      let r = lum, g = lum, b = lum;
      if (sat > 0) {
        // Hue wheel: 0° green, 90° orange, 180° violet, 270° blue.
        let t = Math.atan2(im, re) / (Math.PI / 2);
        t = ((t % 4) + 4) % 4;
        const i0 = Math.floor(t) & 3;
        const i1 = (i0 + 1) & 3;
        const f = t - Math.floor(t);
        const a = HUE_RGB[i0], c = HUE_RGB[i1];
        const hr = a[0] + (c[0] - a[0]) * f;
        const hg = a[1] + (c[1] - a[1]) * f;
        const hb = a[2] + (c[2] - a[2]) * f;
        r += (hr - r) * sat;
        g += (hg - g) * sat;
        b += (hb - b) * sat;
      }
      px[out + x] = pack(r < 0 ? 0 : r > 255 ? 255 : r | 0,
        g < 0 ? 0 : g > 255 ? 255 : g | 0,
        b < 0 ? 0 : b > 255 ? 255 : b | 0);
    }
    this.prevLine = y;
  }

  /** Text rows [start, end) — glyphs into the 1-bit line path. */
  private textRows(s: Apple2VideoState, start: number, end: number): void {
    const page = s.page2 ? 'page2' : 'page1';
    for (let row = start; row < end; row++) {
      const addr = textRowBase(page, row);
      const y0 = row * 8;
      // Attributes are in the top two bits: $80-$FF normal, $40-$7F flashing
      // (alternating normal/inverse), $00-$3F inverse. The glyph is the low six.
      for (let r = 0; r < 8; r++) {
        for (let col = 0; col < 40; col++) {
          const b = s.ram[(addr + col) & 0xFFFF];
          const hi = b & 0xC0;
          const inverse = hi === 0x00 || (hi === 0x40 && s.flashPhase);
          const bits = s.charset.glyphRow(b & 0x3F, r);
          for (let x = 0; x < 7; x++) {
            const on = (bits >> (6 - x)) & 1;
            this.level[col * 7 + x] = (on ^ (inverse ? 1 : 0)) ? 1 : 0;
          }
        }
        this.quarter.fill(0);
        this.paintLine(s, y0 + r);
      }
    }
  }

  /** Lores: 40×48 blocks, each 7×4 pixels; the byte's nibbles are two blocks. */
  private lores(s: Apple2VideoState): void {
    const px = this.pixels32;
    const page = s.page2 ? 'page2' : 'page1';
    const pal = s.mode === 'mono' ? LORES_LUMA
      : s.mode === 'green' ? LORES_GREEN : LORES;
    for (let br = 0; br < 48; br++) {
      const addr = textRowBase(page, br >> 1);
      const y0 = ACTIVE_Y + br * 4;
      const high = (br & 1) === 1;
      for (let col = 0; col < 40; col++) {
        const b = s.ram[(addr + col) & 0xFFFF];
        const colour = pal[(high ? (b >> 4) : b) & 0x0F];
        const x0 = ACTIVE_X + col * 7;
        for (let y = 0; y < 4; y++) {
          const out = (y0 + y) * W;
          px.fill(colour, out + x0, out + x0 + 7);
        }
      }
    }
  }

  /** Hires: 280×192, seven pixels per byte (bit 0 leftmost) plus the half-dot. */
  private hires(s: Apple2VideoState): void {
    const page = s.page2 ? 'page2' : 'page1';
    for (let y = 0; y < 192; y++) {
      const addr = hiresRowBase(page, y);
      for (let col = 0; col < 40; col++) {
        const b = s.ram[(addr + col) & 0xFFFF];
        const q = (b & 0x80) !== 0 ? 1 : 0;
        for (let i = 0; i < 7; i++) {
          this.level[col * 7 + i] = (b >> i) & 1;
          this.quarter[col * 7 + i] = q;
        }
      }
      this.paintLine(s, y);
    }
  }
}

function clampIndex(x: number): number {
  return x < 0 ? 0 : x >= ACTIVE_W ? ACTIVE_W - 1 : x;
}
