/**
 * The VIC's sixteen colours.
 *
 * The chip makes them as luminance and chroma, so any RGB set is a measurement
 * of one chip on one display. These are the widely used "Mike" measurements
 * of a PAL 6561. The border and the characters can only use the first eight;
 * the background and the auxiliary colour can use all sixteen.
 */

const VIC_RGB: readonly number[] = [
  0x000000, 0xFFFFFF, 0xB61F21, 0x4DF0FF, 0xB43FFF, 0x44E237, 0x1A34FF, 0xDCD71B,
  0xCA5400, 0xE9B072, 0xE79293, 0x9AF7FD, 0xE09FFF, 0x8FE493, 0x8290FF, 0xE5DE85,
];

/** The palette as 32-bit pixels for a little-endian RGBA frame buffer. */
export const VIC20_PALETTE: Uint32Array = (() => {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const rgb = VIC_RGB[i];
    const r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, b = rgb & 0xFF;
    out[i] = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  return out;
})();

/** Colour names, for the debugger. */
export const VIC20_COLOUR_NAMES: readonly string[] = [
  'black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow',
  'orange', 'light orange', 'pink', 'light cyan', 'light purple', 'light green', 'light blue', 'light yellow',
];
