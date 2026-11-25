/**
 * The TED's 128 colours.
 *
 * A TED colour is seven bits: luminance (bits 4-6) and chroma (bits 0-3), so
 * the palette is indexed `(luminance << 4) | chroma`. The sixteen chromas are
 * the same hues at eight luminances, the top one nearly white and the bottom
 * nearly black. There are three more tables in the literature; these are
 * VICE's "Colodore" TED set (Philip Timmermann's measurements), which match the
 * C64's Colodore palette hue for hue and are what most Plus/4 people use now.
 */

/** 128 RGB values, 8 luminance groups of 16 chromas. */
const TED_RGB: readonly number[] = [
  0x000000, 0x171717, 0x46070A, 0x002A26, 0x3E0246, 0x003300, 0x0F0D70, 0x1F2100,
  0x3E0E00, 0x301700, 0x0F2B00, 0x460326, 0x00310A, 0x031761, 0x1F0770, 0x033100,
  0x000000, 0x262626, 0x591417, 0x013B37, 0x510C59, 0x054501, 0x1E1C85, 0x303200,
  0x511C01, 0x422700, 0x1E3C00, 0x590E37, 0x014217, 0x0F2675, 0x301385, 0x0F4300,
  0x000000, 0x373737, 0x6D2327, 0x0C4E49, 0x641B6D, 0x12580C, 0x2E2C9B, 0x414400,
  0x642C0C, 0x553800, 0x2E4E00, 0x6D1D49, 0x0C5527, 0x1D378A, 0x41229B, 0x1D5600,
  0x000000, 0x4A4A4A, 0x813338, 0x1A615D, 0x792A82, 0x206C1A, 0x3F3DB1, 0x545700,
  0x793D1A, 0x684A07, 0x3F6200, 0x812D5D, 0x1A6938, 0x2D49A0, 0x5433B1, 0x2D6907,
  0x000000, 0x7B7B7B, 0xB86267, 0x449690, 0xAF58B9, 0x4CA144, 0x706DEB, 0x878A1F,
  0xAF6E44, 0x9D7C2B, 0x70961F, 0xB85A90, 0x449E67, 0x5B7BD9, 0x8762EB, 0x5B9E2B,
  0x000000, 0x9B9B9B, 0xDB8186, 0x61B7B1, 0xD176DC, 0x69C360, 0x8F8CFF, 0xA8AB38,
  0xD18D60, 0xBF9C45, 0x8FB738, 0xDB79B1, 0x61C086, 0x799BFD, 0xA880FF, 0x79C045,
  0x000000, 0xE0E0E0, 0xFFC3C9, 0xA0FEF8, 0xFFB7FF, 0xA9FF9F, 0xD3D0FF, 0xEDF171,
  0xFFD19F, 0xFFE081, 0xD3FE71, 0xFFBAF8, 0xA0FFC9, 0xBBE0FF, 0xEDC3FF, 0xBBFF81,
  0x000000, 0xFFFFFF, 0xFFFFFF, 0xFDFFFF, 0xFFFFFF, 0xFFFFFD, 0xFFFFFF, 0xFFFFC9,
  0xFFFFFD, 0xFFFFDB, 0xFFFFC9, 0xFFFFFF, 0xFDFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFDB,
];

/** The palette as 32-bit pixels for a little-endian RGBA frame buffer. */
export const PLUS4_PALETTE: Uint32Array = (() => {
  const out = new Uint32Array(128);
  for (let i = 0; i < 128; i++) {
    const rgb = TED_RGB[i];
    const r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, b = rgb & 0xFF;
    out[i] = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  return out;
})();

/** Colour names, for the debugger, in the chip's own order. */
export const PLUS4_COLOUR_NAMES: readonly string[] = [
  'black', 'dark grey', 'dark red', 'dark cyan', 'dark purple', 'dark green', 'dark blue', 'dark yellow',
  'orange', 'brown', 'olive', 'pink', 'moss', 'dark light-blue', 'purple', 'green',
  'black', 'grey', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow',
  'orange', 'brown', 'olive', 'pink', 'moss', 'light blue', 'light purple', 'light green',
  'black', 'grey', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow',
  'orange', 'brown', 'olive', 'pink', 'moss', 'light blue', 'light purple', 'light green',
  'black', 'grey', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow',
  'orange', 'brown', 'olive', 'pink', 'moss', 'light blue', 'light purple', 'light green',
  'black', 'light grey', 'light red', 'light cyan', 'light purple', 'light green', 'light blue', 'yellow',
  'light orange', 'light brown', 'light olive', 'light pink', 'light moss', 'light blue', 'light purple', 'light green',
  'black', 'light grey', 'light red', 'light cyan', 'light purple', 'light green', 'light blue', 'light yellow',
  'light orange', 'light brown', 'light olive', 'light pink', 'light moss', 'light blue', 'light purple', 'light green',
  'black', 'very light grey', 'very light red', 'very light cyan', 'very light purple', 'very light green',
  'very light blue', 'very light yellow', 'very light orange', 'very light brown', 'very light olive',
  'very light pink', 'very light moss', 'very light blue', 'very light purple', 'very light green',
  'black', 'white', 'white', 'white', 'white', 'white', 'white', 'near white',
  'white', 'near white', 'near white', 'white', 'white', 'white', 'white', 'near white',
];

/** The colour a TED register holds, as a name ("2 (dark red)"). */
export function plus4ColourName(value: number): string {
  const idx = value & 0x7F;
  return `${idx} (luminance ${(idx >> 4) & 7}, chroma ${idx & 0x0F})`;
}
