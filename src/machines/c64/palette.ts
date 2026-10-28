/**
 * The VIC-II's sixteen colours.
 *
 * The chip makes them as luminance and chroma, so any RGB set is a measurement
 * of one chip on one display. This is the "Colodore" set (Philip Timmermann's
 * 2017 measurements of a PAL 6569), which most C64 people now regard as the
 * closest to a real machine on a real TV.
 */

const COLODORE: readonly number[] = [
  0x000000, 0xFFFFFF, 0x813338, 0x75CEC8, 0x8E3C97, 0x56AC4D, 0x2E2C9B, 0xEDF171,
  0x8E5029, 0x553800, 0xC46C71, 0x4A4A4A, 0x7B7B7B, 0xA9FF9F, 0x706DEB, 0xB2B2B2,
];

/** The palette as 32-bit pixels for a little-endian RGBA frame buffer. */
export const C64_PALETTE: Uint32Array = (() => {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const rgb = COLODORE[i];
    const r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, b = rgb & 0xFF;
    out[i] = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  return out;
})();

/** Colour names, for the debugger. */
export const C64_COLOUR_NAMES: readonly string[] = [
  'black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow',
  'orange', 'brown', 'light red', 'dark grey', 'grey', 'light green', 'light blue', 'light grey',
];
