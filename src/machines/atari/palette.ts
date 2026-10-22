/**
 * GTIA colour palettes.
 *
 * There is no single right Atari palette: the colour pot on the motherboard
 * sets the phase step between hues, the display's tint control rotates them
 * all, and each model's video circuit has its own luma and chroma levels.
 *
 * NTSC follows the Atari800 emulator's generator (src/colours_ntsc.c), so the
 * palette is the one a long line of emulators and their users have tuned
 * software against. Hue 0 carries no chroma. Hues 1-15 are the colour
 * subcarrier delayed by 1-15 equal steps, hue 1 sitting at the NTSC burst
 * angle, 303 degrees in I-Q (270 in YUV plus the 33 degree YIQ rotation):
 *
 *     angle(hue) = 303 + 26.8 x (hue - 1)
 *
 * The 26.8 degree step is what makes the hue names in the Atari hardware
 * manual (GTIA.PDF) come out right, and it carries hue 15 about 15 degrees
 * past hue 1, as it does on many real machines. Chroma has the same
 * amplitude for every hue, 0.175 of the luma range. Luma is the 16-entry table
 * from the CGIA specification, normalised to black-to-white. I and Q become
 * gamma-encoded RGB with the standard NTSC matrix, which is linearised at the
 * 2.35 gamma of a typical CRT and re-encoded as sRGB. Unlike the emulator,
 * which leaves black at 16/255 and white at 235/255, the range here is
 * stretched to 0-255 so white reads as white.
 *
 * PAL is computed from the analogue video model in the Altirra Hardware
 * Reference Manual (section 6.3 and appendix D). The PAL GTIA uses different
 * delays on even and odd lines (table 14), so that after the alternate-line
 * V inversion both decode to the same angle at the nominal 22.5 degree step.
 * A PAL TV's delay line averages the two lines' chroma, which is what this
 * palette shows. Hues 1 and 15 use the same delays, so they always match.
 * Luma is a resistor DAC (table 116) and chroma, as a fraction of the 0-15
 * luma range, is 30.6% on a 400, 35.0% on an 800 and 23.9% on an 800XL
 * (table 117). Y/U/V gives gamma-encoded RGB, which is hard-clamped at zero
 * as a CRT clamps it; the corrected preset then linearises it (gamma 2.2),
 * moves it from the EBU primaries to sRGB through XYZ and re-encodes it.
 * The uncorrected one reads the RGB straight as sRGB.
 *
 * Colour values are GTIA bytes: bits 7-4 hue, bits 3-0 luma (bit 0 is reached
 * only by GTIA mode 9).
 */

export type AtariPaletteId = 'tv' | 'monitor' | 'uncorrected';

/** Which machine's video circuit the measured PAL levels come from. */
export type AtariVideoBoard = '400' | '800' | 'xl';

export interface AtariPaletteOption {
  readonly value: AtariPaletteId;
  readonly label: string;
  readonly title: string;
}

const NTSC_OPTIONS: readonly AtariPaletteOption[] = [
  {
    value: 'tv',
    label: 'Atari800 NTSC',
    title: 'The Atari800 emulator\'s NTSC palette: CGIA luma table, 26.8° per hue from the NTSC '
      + 'burst, gamma 2.35.',
  },
  {
    value: 'monitor',
    label: 'Commodore 1702',
    title: 'The same palette with every hue about 24° redder, where a 1702 monitor\'s tint control '
      + 'centres: the look many NTSC games were developed on.',
  },
];

const PAL_OPTIONS: readonly AtariPaletteOption[] = [
  {
    value: 'tv',
    label: 'PAL TV',
    title: 'The PAL GTIA\'s per-line delays at the nominal 22.5°, averaged over two lines by the TV\'s '
      + 'delay line, EBU primaries corrected to sRGB.',
  },
  {
    value: 'uncorrected',
    label: 'Uncorrected YUV',
    title: 'The same hues with YUV read straight as sRGB.',
  },
];

/** The palettes that apply to a region, default first. */
export function atariPaletteOptions(pal: boolean): readonly AtariPaletteOption[] {
  return pal ? PAL_OPTIONS : NTSC_OPTIONS;
}

/** A stored palette id, or the region's default if it does not apply there. */
export function resolveAtariPalette(pal: boolean, id: string): AtariPaletteId {
  const options = atariPaletteOptions(pal);
  return options.find(option => option.value === id)?.value ?? options[0].value;
}

// ── NTSC (Atari800 colours_ntsc.c) ─────────────────────────────────────────

/** Hue 1 at the NTSC colour burst, in I-Q degrees. */
const NTSC_BURST_IQ = 303;
/** Degrees between hues; Atari800's choice to match the GTIA.PDF colour names. */
const NTSC_STEP = 26.8;
/** A 1702 monitor\'s tint control centres hue 1 this far round from the burst. */
const MONITOR_TINT = 24;
const NTSC_SATURATION = 0.175;
const NTSC_GAMMA = 2.35;
/** Luma 0-15 multipliers from the CGIA specification. */
const NTSC_LUMA: readonly number[] = [
  0.6941, 0.7091, 0.7241, 0.7401, 0.7560, 0.7741, 0.7931, 0.8121,
  0.8260, 0.8470, 0.8700, 0.8930, 0.9160, 0.9420, 0.9690, 1.0000,
];

// ── PAL: measured figures (Altirra Hardware Reference Manual, appendix D) ──

/** PAL luma 0-15 output voltages (table 116). The 600XL/1200XL share the
 *  800XL's circuit. */
const LUMA_VOLTS: Readonly<Record<AtariVideoBoard, readonly number[]>> = {
  '400': [3.736, 3.752, 3.768, 3.780, 3.792, 3.808, 3.820, 3.836,
    3.848, 3.864, 3.876, 3.892, 3.904, 3.920, 3.936, 3.952],
  '800': [0.640, 0.696, 0.744, 0.800, 0.856, 0.904, 0.960, 1.016,
    1.056, 1.112, 1.160, 1.224, 1.272, 1.328, 1.384, 1.440],
  xl: [1.112, 1.184, 1.264, 1.334, 1.408, 1.488, 1.568, 1.648,
    1.688, 1.760, 1.840, 1.928, 1.992, 2.072, 2.144, 2.224],
};

/** Chroma amplitude as a fraction of the luma 0-15 range (table 117). */
const SATURATION: Readonly<Record<AtariVideoBoard, number>> = {
  '400': 0.306,
  '800': 0.350,
  xl: 0.239,
};

/** PAL GTIA delays per hue, on even and odd lines, with whether that line's
 *  subcarrier is inverted (table 14). Index 0 is hue 1. */
const PAL_DELAYS: readonly (readonly [even: number, evenInv: boolean, odd: number, oddInv: boolean])[] = [
  [1, false, 5, false],
  [0, false, 6, false],
  [7, true, 7, false],
  [6, true, 0, true],
  [5, true, 1, true],
  [4, true, 2, true],
  [2, true, 4, true],
  [1, true, 5, true],
  [0, true, 6, true],
  [7, false, 7, true],
  [5, false, 1, false],
  [4, false, 2, false],
  [3, false, 3, false],
  [2, false, 4, false],
  [1, false, 5, false],
];
const PAL_STEP = 22.5;
/** The PAL burst (hue 1) decodes to 135 degrees in U-V on both lines. */
const PAL_BURST_UV = 135;

// ── Colour science ─────────────────────────────────────────────────────────

type Mat3 = readonly [number, number, number, number, number, number, number, number, number];
type Xy = readonly [x: number, y: number];

function mul(a: Mat3, b: Mat3): Mat3 {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
    }
  }
  return r as unknown as Mat3;
}

function inverse(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

function apply(m: Mat3, v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

const xyz = ([x, y]: Xy): [number, number, number] => [x / y, 1, (1 - x - y) / y];

/** Linear RGB to XYZ for a set of primaries and white point. */
function rgbToXyz(r: Xy, g: Xy, b: Xy, white: Xy): Mat3 {
  const [xr, yr, zr] = xyz(r);
  const [xg, yg, zg] = xyz(g);
  const [xb, yb, zb] = xyz(b);
  const p: Mat3 = [xr, xg, xb, yr, yg, yb, zr, zg, zb];
  const [sr, sg, sb] = apply(inverse(p), xyz(white));
  return [xr * sr, xg * sg, xb * sb, yr * sr, yg * sg, yb * sb, zr * sr, zg * sg, zb * sb];
}

const D65: Xy = [0.3127, 0.3290];
const XYZ_TO_SRGB = inverse(rgbToXyz([0.64, 0.33], [0.30, 0.60], [0.15, 0.06], D65));
/** EBU primaries (D65) to linear sRGB. */
const EBU_TO_SRGB = mul(XYZ_TO_SRGB, rgbToXyz([0.64, 0.33], [0.29, 0.60], [0.15, 0.06], D65));

const DISPLAY_GAMMA = 2.2;

function srgbEncode(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

const rad = (degrees: number) => (degrees * Math.PI) / 180;
const toByte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);

function pack(r: number, g: number, b: number): number {
  return (0xFF000000 | (toByte(b) << 16) | (toByte(g) << 8) | toByte(r)) >>> 0;
}

// ── NTSC palette ───────────────────────────────────────────────────────────

function buildNtsc(id: AtariPaletteId): Uint32Array {
  const burst = NTSC_BURST_IQ + (id === 'monitor' ? MONITOR_TINT : 0);
  const palette = new Uint32Array(256);
  const lo = NTSC_LUMA[0];
  const span = NTSC_LUMA[15] - lo;
  for (let hue = 0; hue < 16; hue++) {
    const angle = rad(burst + NTSC_STEP * (hue - 1));
    const i = hue ? Math.cos(angle) * NTSC_SATURATION : 0;
    const q = hue ? Math.sin(angle) * NTSC_SATURATION : 0;
    for (let luma = 0; luma < 16; luma++) {
      const y = (NTSC_LUMA[luma] - lo) / span;
      // YIQ to gamma-encoded RGB; a CRT can't show a negative, so clamp it,
      // then linearise at the CRT's gamma and re-encode as sRGB.
      const rgb = [
        y + 0.9563 * i + 0.6210 * q,
        y - 0.2721 * i - 0.6474 * q,
        y - 1.1070 * i + 1.7046 * q,
      ].map(c => srgbEncode(Math.pow(Math.max(0, c), NTSC_GAMMA)));
      palette[hue << 4 | luma] = pack(rgb[0], rgb[1], rgb[2]);
    }
  }
  return palette;
}

// ── PAL palette ────────────────────────────────────────────────────────────

/** The U-V chroma vector of a hue (1-15), before scaling. */
function palHueVector(hue: number): [number, number] {
  // Each line's phase relative to the burst, which the TV locks to 135
  // degrees on both; the delay line then averages the two.
  const [even, evenInv, odd, oddInv] = PAL_DELAYS[hue - 1];
  const a = rad(PAL_BURST_UV + PAL_STEP * (even - 1) + (evenInv ? 180 : 0));
  const b = rad(PAL_BURST_UV - PAL_STEP * (odd - 5) + (oddInv ? 180 : 0));
  return [(Math.cos(a) + Math.cos(b)) / 2, (Math.sin(a) + Math.sin(b)) / 2];
}

function buildPal(id: AtariPaletteId, board: AtariVideoBoard): Uint32Array {
  const corrected = id !== 'uncorrected';
  let luma: number[];
  if (corrected) {
    // The DAC is the motherboard's; PAL has no black pedestal to sit under.
    const volts = LUMA_VOLTS[board];
    luma = volts.map(v => (v - volts[0]) / (volts[15] - volts[0]));
  } else {
    luma = Array.from({ length: 16 }, (_, b) => b / 15);
  }
  const chroma = SATURATION[board];
  const palette = new Uint32Array(256);
  for (let value = 0; value < 256; value++) {
    const hue = value >> 4;
    const y = luma[value & 0x0F];
    let u = 0;
    let v = 0;
    if (hue !== 0) {
      [u, v] = palHueVector(hue);
      u *= chroma;
      v *= chroma;
    }
    // YUV to gamma-encoded RGB, hard-clamped at zero as a CRT clamps it.
    let rgb: [number, number, number] = [
      Math.max(0, y + 1.140 * v),
      Math.max(0, y - 0.395 * u - 0.581 * v),
      Math.max(0, y + 2.032 * u),
    ];
    if (corrected) {
      const linear = rgb.map(c => Math.pow(c, DISPLAY_GAMMA)) as [number, number, number];
      rgb = apply(EBU_TO_SRGB, linear)
        .map(c => srgbEncode(Math.min(1, Math.max(0, c)))) as [number, number, number];
    }
    palette[value] = pack(rgb[0], rgb[1], rgb[2]);
  }
  return palette;
}

/**
 * The 256-entry GTIA palette as ABGR words (the renderer's byte order).
 * `board` picks the measured PAL luma and saturation (default the XL's); the
 * NTSC palette does not depend on it.
 */
export function buildAtariPalette(
  pal: boolean,
  id: AtariPaletteId = 'tv',
  board: AtariVideoBoard = 'xl',
): Uint32Array {
  const resolved = resolveAtariPalette(pal, id);
  return pal ? buildPal(resolved, board) : buildNtsc(resolved);
}
