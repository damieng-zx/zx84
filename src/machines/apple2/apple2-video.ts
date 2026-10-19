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
 *                The phosphor colour (green, amber…) is the Monitor pane's
 *                tint, applied to every machine by the renderer.
 *  - `ntsc`      composite NTSC: the 1-bit sources (text and hires) are
 *                correlated against the colour subcarrier and low-passed,
 *                which is what makes the Apple II's artifact colours. A run of
 *                like pixels has no chroma and reads black or white, an
 *                alternating pattern sits exactly on the subcarrier and reads
 *                as one saturated hue, and an isolated dot leaves a fringe.
 *  - `pal`       the same decoder against the PAL dot-clock/subcarrier ratio
 *                (so patterns land on different hues) with PAL's per-line V
 *                switch and one-line chroma delay.
 *
 * Text goes through the same 1-bit path, so in the composite modes glyph edges
 * pick up colour fringes, as they do on a colour monitor. Lores is drawn from a
 * fixed 16-colour table in both composite modes: its colours come from the
 * video generator's own phase table, not from decoding a 1-bit stream.
 */

import {
  APPLE2_ACTIVE_WIDTH, APPLE2_BORDER_LEFT, APPLE2_BORDER_TOP, APPLE2_NARROW_WIDTH,
  APPLE2_SCREEN_WIDTH, APPLE2_SCREEN_HEIGHT,
} from './constants.ts';
import type { Apple2Font } from './apple2-charset.ts';
import { VIDEX_CELL_HEIGHT, VIDEX_COLS, VIDEX_ROWS, type VidexView } from './peripherals/videx.ts';

const W = APPLE2_SCREEN_WIDTH;
const H = APPLE2_SCREEN_HEIGHT;
const ACTIVE_X = APPLE2_BORDER_LEFT;
const ACTIVE_Y = APPLE2_BORDER_TOP;
const FULL_W = APPLE2_ACTIVE_WIDTH;            // dots per line at the 14 MHz dot clock
const ACTIVE_W = APPLE2_NARROW_WIDTH;     // source dots per line (each drawn twice)

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
/** Fraction of full chroma below which a pixel is treated as colourless. */
const CHROMA_KNEE = 0.15;

/** Chroma / luminance averaging kernel at the full 560-dot rate: the same
 *  triangle, twice as wide because each dot is half as long. Sixteen taps is a
 *  whole number of subcarrier cycles (four dots each), so a period-4 pattern —
 *  a double hi-res colour — averages cleanly. */
const KERNEL_FULL = [1, 2, 3, 4, 5, 6, 7, 8, 8, 7, 6, 5, 4, 3, 2, 1].map(v => v / 72);
const KERNEL_FULL_OFF = -8;

/** Subcarrier phase advanced per pixel: NTSC's dot clock is twice the
 *  subcarrier (180°), PAL's 7.125 MHz is not (≈224°). */
const NTSC_PHASE_PER_PIXEL = Math.PI;
const PAL_PHASE_PER_PIXEL = 2 * Math.PI * (4.43361875 / 7.125);
/** The same at the 14 MHz dot clock: NTSC is exactly a quarter cycle per dot. */
const NTSC_PHASE_PER_DOT = Math.PI / 2;
const PAL_PHASE_PER_DOT = 2 * Math.PI * (4.43361875 / 14.25);

export type Apple2VideoMode = 'mono' | 'ntsc' | 'pal';

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
  charset: Apple2Font;
  flashPhase: boolean;
  mode: Apple2VideoMode;
  /** IIe: auxiliary RAM (null or absent without the 80-column card / on a ][+). */
  aux?: Uint8Array | null;
  /** IIe: 80-column text, and double hi-res when `dhires` is also set. */
  col80?: boolean;
  dhires?: boolean;
  /** IIe: the alternate character set (lowercase, no flashing). */
  altCharset?: boolean;
  /** A Videx Videoterm card's display, which replaces the Apple's own when active. */
  videx?: VidexView | null;
}

function pack(r: number, g: number, b: number): number {
  return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
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

  /** One 560-dot source line (80-column text, double hi-res). */
  private readonly dots = new Float32Array(FULL_W);
  private tableMode560: Apple2VideoMode | null = null;
  private cos560 = new Float32Array(FULL_W);
  private sin560 = new Float32Array(FULL_W);
  private dotOffset = 0;
  private fullChroma560 = 0.5;

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
    if (s.videx?.active) {
      this.videxText(s, s.videx);
      return;
    }
    if (s.mode === 'ntsc' || s.mode === 'pal') this.ensureTables(s.mode);
    if (s.textMode) {
      this.textRows(s, 0, 24);
      return;
    }
    if (s.hires) {
      if (s.col80 && s.dhires) this.doubleHires(s);
      else this.hires(s);
    } else this.lores(s);
    if (s.mixed) this.textRows(s, 20, 24);
  }

  /** Paint one 280-dot 1-bit source line at buffer row `y`, each dot as two pixels. */
  private paintLine(s: Apple2VideoState, y: number): void {
    const out = (ACTIVE_Y + y) * W + ACTIVE_X;
    const px = this.pixels32;
    if (s.mode === 'mono') {
      for (let x = 0; x < ACTIVE_W; x++) {
        px[out + 2 * x] = px[out + 2 * x + 1] = this.level[x] > 0.5 ? WHITE : BLACK;
      }
      return;
    }
    const pal = s.mode === 'pal';
    const delayLine = pal && y - 1 === this.prevLine;
    for (let x = 0; x < ACTIVE_W; x++) {
      // Most of a screen is flat black or white: a window of identical dots has
      // no chroma, so skip the demodulation (and the sqrt/atan2) for it. The PAL
      // delay line still needs the full path while the line above has chroma here.
      const first = this.level[clampIndex(x + KERNEL_OFF)];
      let flat = true;
      for (let k = 1; k < KERNEL.length; k++) {
        if (this.level[clampIndex(x + k + KERNEL_OFF)] !== first) { flat = false; break; }
      }
      if (flat && !(delayLine && (this.prevRe[x] !== 0 || this.prevIm[x] !== 0))) {
        px[out + 2 * x] = px[out + 2 * x + 1] = first > 0.5 ? WHITE : BLACK;
        this.prevRe[x] = 0;
        this.prevIm[x] = 0;
        continue;
      }
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
      // chroma — taken from the raw (pre-average) value so it is a one-line
      // delay, not a recursive filter.
      const rawRe = re, rawIm = im;
      if (delayLine) { re = (re + this.prevRe[x]) / 2; im = (im + this.prevIm[x]) / 2; }
      this.prevRe[x] = rawRe;
      this.prevIm[x] = rawIm;

      const mag = Math.sqrt(re * re + im * im);
      // Soft knee: the chroma kernel's tails leave a faint residue (a tenth or
      // two of full chroma) several dots from any edge, which reads as a pale
      // echo beside text on a light ground. A decoder's colour killer discards
      // chroma that weak; real colour (alternating patterns, a stroke's fringe)
      // sits well above it.
      const raw = mag >= FULL_CHROMA ? 1 : mag / FULL_CHROMA;
      const sat = raw <= CHROMA_KNEE ? 0 : (raw - CHROMA_KNEE) / (1 - CHROMA_KNEE);
      // Luma keeps nearly the full dot bandwidth: a real decoder only notches
      // out the subcarrier. [1 2 1]/4 is exactly that notch at NTSC's dot rate
      // (a period-2 pattern averages to a half), so glyph and hires edges stay
      // crisp while the wide kernel above is used for chroma alone.
      const lum = 255 * (0.25 * this.level[clampIndex(x - 1)] + 0.5 * this.level[x]
        + 0.25 * this.level[clampIndex(x + 1)]);
      let r = lum, g = lum, b = lum;
      if (sat > 0) {
        // Hue wheel: 0° green, 90° orange, 180° violet, 270° blue.
        let t = Math.atan2(im, re) / (Math.PI / 2);
        t = ((t % 4) + 4) % 4;
        const i0 = Math.floor(t) & 3;
        const i1 = (i0 + 1) & 3;
        const f = t - Math.floor(t);
        const a = HUE_RGB[i0], c = HUE_RGB[i1];
        // The chroma kernel is wider than the sharp luma, so its tails reach
        // dots that are dark. Scale the hue by the local luma (a full-chroma
        // alternating pattern sits at one half) so colour never glows where the
        // picture is black: no coloured echo beside a stroke.
        const gain = lum >= 127.5 ? 1 : lum / 127.5;
        const hr = (a[0] + (c[0] - a[0]) * f) * gain;
        const hg = (a[1] + (c[1] - a[1]) * f) * gain;
        const hb = (a[2] + (c[2] - a[2]) * f) * gain;
        r += (hr - r) * sat;
        g += (hg - g) * sat;
        b += (hb - b) * sat;
      }
      px[out + 2 * x] = px[out + 2 * x + 1] = pack(r < 0 ? 0 : r > 255 ? 255 : r | 0,
        g < 0 ? 0 : g > 255 ? 255 : g | 0,
        b < 0 ? 0 : b > 255 ? 255 : b | 0);
    }
    this.prevLine = y;
  }

  private ensureTables560(mode: Apple2VideoMode): void {
    if (this.tableMode560 === mode) return;
    const step = mode === 'pal' ? PAL_PHASE_PER_DOT : NTSC_PHASE_PER_DOT;
    // A dot pair at the start of the line is what a lit 280-dot pixel is, so
    // colours line up with hi-res: the group's chroma sits half a dot late.
    this.dotOffset = step / 2;
    for (let x = 0; x < FULL_W; x++) {
      this.cos560[x] = Math.cos(step * x);
      this.sin560[x] = Math.sin(step * x);
    }
    // The saturation reference: the chroma of a fully saturated pattern (two
    // dots lit, two dark) in the middle of the line.
    let mean = 0;
    const probe = (x: number): number => ((x >> 1) & 1 ? 0 : 1);
    const mid = FULL_W / 2;
    for (let k = 0; k < KERNEL_FULL.length; k++) mean += KERNEL_FULL[k] * probe(mid + k + KERNEL_FULL_OFF);
    let re = 0, im = 0;
    for (let k = 0; k < KERNEL_FULL.length; k++) {
      const xx = mid + k + KERNEL_FULL_OFF;
      const v = (probe(xx) - mean) * KERNEL_FULL[k];
      re += v * this.cos560[xx];
      im += v * this.sin560[xx];
    }
    this.fullChroma560 = Math.sqrt(re * re + im * im) || 0.5;
    this.tableMode560 = mode;
  }

  /**
   * Paint one 560-dot source line at buffer row `y`. `graphics` lines (double
   * hi-res) are decoded for colour in the composite modes; text is not — the
   * colour burst is off for IIe text — so it is plain white on black there.
   */
  private paintDots(s: Apple2VideoState, y: number, graphics: boolean): void {
    const out = (ACTIVE_Y + y) * W + ACTIVE_X;
    const px = this.pixels32;
    const colour = graphics && (s.mode === 'ntsc' || s.mode === 'pal');
    if (!colour) {
      for (let x = 0; x < FULL_W; x++) px[out + x] = this.dots[x] > 0.5 ? WHITE : BLACK;
      return;
    }
    this.ensureTables560(s.mode);
    const last = FULL_W - 1;
    const at = (x: number): number => this.dots[x < 0 ? 0 : x > last ? last : x];
    for (let x = 0; x < FULL_W; x++) {
      const first = at(x + KERNEL_FULL_OFF);
      let flat = true;
      for (let k = 1; k < KERNEL_FULL.length; k++) {
        if (at(x + k + KERNEL_FULL_OFF) !== first) { flat = false; break; }
      }
      if (flat) { px[out + x] = first > 0.5 ? WHITE : BLACK; continue; }
      let mean = 0;
      for (let k = 0; k < KERNEL_FULL.length; k++) mean += KERNEL_FULL[k] * at(x + k + KERNEL_FULL_OFF);
      let re = 0, im = 0;
      for (let k = 0; k < KERNEL_FULL.length; k++) {
        const xx = x + k + KERNEL_FULL_OFF;
        const v = (at(xx) - mean) * KERNEL_FULL[k];
        const ci = xx < 0 ? 0 : xx > last ? last : xx;
        re += v * this.cos560[ci];
        im += v * this.sin560[ci];
      }
      const mag = Math.sqrt(re * re + im * im);
      const raw = mag >= this.fullChroma560 ? 1 : mag / this.fullChroma560;
      const sat = raw <= CHROMA_KNEE ? 0 : (raw - CHROMA_KNEE) / (1 - CHROMA_KNEE);
      const lum = 255 * mean;
      let r = lum, g = lum, b = lum;
      if (sat > 0) {
        let t = (Math.atan2(im, re) - this.dotOffset) / (Math.PI / 2);
        t = ((t % 4) + 4) % 4;
        const i0 = Math.floor(t) & 3;
        const i1 = (i0 + 1) & 3;
        const f = t - Math.floor(t);
        const a = HUE_RGB[i0], c = HUE_RGB[i1];
        const gain = lum >= 127.5 ? 1 : lum / 127.5;
        r += ((a[0] + (c[0] - a[0]) * f) * gain - r) * sat;
        g += ((a[1] + (c[1] - a[1]) * f) * gain - g) * sat;
        b += ((a[2] + (c[2] - a[2]) * f) * gain - b) * sat;
      }
      px[out + x] = pack(r < 0 ? 0 : r > 255 ? 255 : r | 0,
        g < 0 ? 0 : g > 255 ? 255 : g | 0,
        b < 0 ? 0 : b > 255 ? 255 : b | 0);
    }
  }

  /**
   * Double hi-res: 560 dots across, two bytes per 14-dot cell — auxiliary RAM
   * first, then main, seven dots each with bit 0 leftmost. The colour is the
   * pattern of every four dots.
   */
  private doubleHires(s: Apple2VideoState): void {
    const page = s.page2 ? 'page2' : 'page1';
    const aux = s.aux ?? null;
    for (let y = 0; y < 192; y++) {
      const addr = hiresRowBase(page, y);
      for (let col = 0; col < 40; col++) {
        const a = aux ? aux[(addr + col) & 0xFFFF] : 0;
        const m = s.ram[(addr + col) & 0xFFFF];
        for (let i = 0; i < 7; i++) {
          this.dots[col * 14 + i] = (a >> i) & 1;
          this.dots[col * 14 + 7 + i] = (m >> i) & 1;
        }
      }
      this.paintDots(s, y, true);
    }
  }

  /**
   * The Videx Videoterm's output: 80 by 24 characters of seven dots by nine scan
   * lines, centred in the frame, in white. A character code's
   * top bit is inverse video; the cursor inverts its scan lines, steady or at the
   * flash rate.
   */
  private videxText(s: Apple2VideoState, v: VidexView): void {
    const px = this.pixels32;
    const lit = WHITE;
    const top = ((H - VIDEX_ROWS * VIDEX_CELL_HEIGHT) >> 1);
    const cursorShown = v.cursorMode === 0 || ((v.cursorMode & 2) !== 0 && s.flashPhase);
    for (let row = 0; row < VIDEX_ROWS; row++) {
      for (let line = 0; line < VIDEX_CELL_HEIGHT; line++) {
        const out = (top + row * VIDEX_CELL_HEIGHT + line) * W + ACTIVE_X;
        for (let col = 0; col < VIDEX_COLS; col++) {
          const addr = (v.start + row * VIDEX_COLS + col) & 0x7FF;
          const code = v.ram[addr];
          let bits = v.font[((code & 0x7F) << 4) | line] ?? 0;
          if (code & 0x80) bits = ~bits;
          if (cursorShown && addr === v.cursor && line >= v.cursorStart && line <= v.cursorEnd) bits = ~bits;
          const x = out + col * 7;
          for (let d = 0; d < 7; d++) px[x + d] = (bits >> (7 - d)) & 1 ? lit : BLACK;
        }
      }
    }
  }

  /** Text rows [start, end) — glyphs into the 1-bit line path. */
  private textRows(s: Apple2VideoState, start: number, end: number): void {
    const page = s.page2 ? 'page2' : 'page1';
    const alt = !!s.altCharset;
    const wide = !!s.col80;
    for (let row = start; row < end; row++) {
      const addr = textRowBase(page, row);
      const y0 = row * 8;
      for (let r = 0; r < 8; r++) {
        if (wide) {
          // 80 columns: even columns come from auxiliary RAM, odd from main.
          for (let col = 0; col < 80; col++) {
            const bank = (col & 1) === 0 ? (s.aux ?? null) : s.ram;
            const b = bank ? bank[(addr + (col >> 1)) & 0xFFFF] : 0xA0;
            const bits = s.charset.glyph(b, r, s.flashPhase, alt);
            for (let x = 0; x < 7; x++) this.dots[col * 7 + x] = (bits >> (6 - x)) & 1;
          }
          this.paintDots(s, y0 + r, false);
        } else {
          for (let col = 0; col < 40; col++) {
            const b = s.ram[(addr + col) & 0xFFFF];
            const bits = s.charset.glyph(b, r, s.flashPhase, alt);
            for (let x = 0; x < 7; x++) this.level[col * 7 + x] = (bits >> (6 - x)) & 1;
          }
          this.quarter.fill(0);
          this.paintLine(s, y0 + r);
        }
      }
    }
  }

  /** Lores: 40×48 blocks, each 7×4 pixels; the byte's nibbles are two blocks. */
  private lores(s: Apple2VideoState): void {
    const px = this.pixels32;
    const page = s.page2 ? 'page2' : 'page1';
    const pal = s.mode === 'mono' ? LORES_LUMA : LORES;
    for (let br = 0; br < 48; br++) {
      const addr = textRowBase(page, br >> 1);
      const y0 = ACTIVE_Y + br * 4;
      const high = (br & 1) === 1;
      for (let col = 0; col < 40; col++) {
        const b = s.ram[(addr + col) & 0xFFFF];
        const colour = pal[(high ? (b >> 4) : b) & 0x0F];
        const x0 = ACTIVE_X + col * 14;
        for (let y = 0; y < 4; y++) {
          const out = (y0 + y) * W;
          px.fill(colour, out + x0, out + x0 + 14);
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
