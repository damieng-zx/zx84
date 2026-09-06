/**
 * SSX — SimCoupe's SAM screen dump, as ZXDB stores SAM Coupé screenshots.
 *
 * There is no header, no magic and no mode field: the file is the display
 * memory the ASIC was fetching, followed by the CLUT, and the *length* is what
 * says which screen mode wrote it. That is unambiguous because the four modes
 * have four different display sizes and two different CLUT sizes:
 *
 *   6928  = mode 1  (6144 bitmap + 768 attributes, then 16 CLUT entries)
 *   12304 = mode 2  (6144 bitmap + 6144 attributes, then 16)
 *   24580 = mode 3  (24576 bytes of 2bpp, then the 4 mode-3 CLUT entries)
 *   24592 = mode 4  (24576 bytes of 4bpp, then 16)
 *   98304 = a raster dump: 192 lines of 512 palette codes, no CLUT
 *
 * The last is what SimCoupe writes when the screen changed mid-frame and no
 * single mode describes it. ZXDB also carries `.ss4` files, which are the same
 * format under a mode-4-specific name — the length still decides, so they need
 * no separate path.
 *
 * Decoding is deliberately separate from `SamAsic`: the ASIC renders from live
 * paged memory with a per-line journal, and a screenshot has neither. The mode
 * layouts below are the same ones `asic.ts` documents.
 *
 * Transcribed from SimCoupe's `Base/SSX.cpp` (the writer) and verified against
 * ZXDB's own `.ssx`/`.ss4` files.
 */

import { SAM_PALETTES } from './constants.ts';

/** Decoded screens are emitted at mode 3's resolution, as the ASIC samples. */
export const SSX_WIDTH = 512;
export const SSX_HEIGHT = 192;

const DISPLAY_BYTES_12 = 6144;
const MODE1_ATTR_BYTES = 768;
const MODE34_BYTES = 24576;
const CLUT_ENTRIES = 16;
const MODE3_CLUT_ENTRIES = 4;

/** Every length SSX can legitimately have, and the mode each one means. */
const enum Layout { Mode1, Mode2, Mode3, Mode4, Raster }

function layoutFor(length: number): Layout | null {
  switch (length) {
    case DISPLAY_BYTES_12 + MODE1_ATTR_BYTES + CLUT_ENTRIES: return Layout.Mode1;
    case DISPLAY_BYTES_12 * 2 + CLUT_ENTRIES: return Layout.Mode2;
    case MODE34_BYTES + MODE3_CLUT_ENTRIES: return Layout.Mode3;
    case MODE34_BYTES + CLUT_ENTRIES: return Layout.Mode4;
    case SSX_WIDTH * SSX_HEIGHT: return Layout.Raster;
    default: return null;
  }
}

/** True when `data` is a screen this module can decode. Length is the only
 *  evidence there is — the format carries no magic to check. */
export function isSsx(data: Uint8Array): boolean {
  return layoutFor(data.length) !== null;
}

/**
 * Decode an SSX/SS4 screen to 512x192 RGBA, or null if the length matches no
 * known layout.
 *
 * The returned buffer is byte-order RGBA, ready for `ImageData` — the palette
 * is packed ABGR, which is the same bytes in memory on a little-endian host,
 * so the pixels are written through a Uint32Array view of the same buffer.
 */
export function decodeSsx(data: Uint8Array): Uint8ClampedArray<ArrayBuffer> | null {
  const layout = layoutFor(data.length);
  if (layout === null) return null;

  const rgba = new Uint8ClampedArray(new ArrayBuffer(SSX_WIDTH * SSX_HEIGHT * 4));
  const px = new Uint32Array(rgba.buffer);
  const palette = SAM_PALETTES.linear;

  if (layout === Layout.Raster) {
    // Already one palette code per mode-3 pixel.
    for (let i = 0; i < px.length; i++) px[i] = palette[data[i] & 0x7F];
    return rgba;
  }

  // The CLUT is the tail of the file; mode 3 stores only its four entries.
  const clutSize = layout === Layout.Mode3 ? MODE3_CLUT_ENTRIES : CLUT_ENTRIES;
  const clutAt = data.length - clutSize;
  const lut = new Uint32Array(CLUT_ENTRIES);
  for (let i = 0; i < clutSize; i++) lut[i] = palette[data[clutAt + i] & 0x7F];

  switch (layout) {
    case Layout.Mode1: return mode1(data, px, lut), rgba;
    case Layout.Mode2: return mode2(data, px, lut), rgba;
    case Layout.Mode3: return mode3(data, px, lut), rgba;
    default: return mode4(data, px, lut), rgba;
  }
}

/** Plot eight bitmap pixels through an ink/paper attribute, two pixels each.
 *  FLASH is ignored: a screenshot has no phase to be in. */
function attrCell(px: Uint32Array, at: number, bits: number, attr: number, lut: Uint32Array): void {
  const bright = (attr & 0x40) >> 3;
  const ink = lut[(attr & 0x07) | bright];
  const paper = lut[((attr >> 3) & 0x07) | bright];
  for (let b = 0; b < 8; b++) {
    const colour = (bits & (0x80 >> b)) !== 0 ? ink : paper;
    px[at] = colour;
    px[at + 1] = colour;
    at += 2;
  }
}

/** Mode 1 — the Spectrum's third/char-row/pixel-row bitmap interleave, with
 *  one attribute per 8x8 cell at +6144. */
function mode1(data: Uint8Array, px: Uint32Array, lut: Uint32Array): void {
  for (let y = 0; y < SSX_HEIGHT; y++) {
    const row = y * SSX_WIDTH;
    for (let col = 0; col < 32; col++) {
      const bmp = ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | col;
      const attr = DISPLAY_BYTES_12 + ((y >> 3) << 5) + col;
      attrCell(px, row + col * 16, data[bmp], data[attr], lut);
    }
  }
}

/** Mode 2 — linear bitmap, with one attribute per cell PER LINE at +0x2000. */
function mode2(data: Uint8Array, px: Uint32Array, lut: Uint32Array): void {
  for (let y = 0; y < SSX_HEIGHT; y++) {
    const row = y * SSX_WIDTH;
    for (let col = 0; col < 32; col++) {
      const at = (y << 5) + col;
      attrCell(px, row + col * 16, data[at], data[0x2000 + at], lut);
    }
  }
}

/** Mode 3 — 512x192, two bits per pixel, most-significant pair leftmost. */
function mode3(data: Uint8Array, px: Uint32Array, lut: Uint32Array): void {
  for (let y = 0; y < SSX_HEIGHT; y++) {
    let at = y * SSX_WIDTH;
    const line = y << 7;
    for (let i = 0; i < 128; i++) {
      const b = data[line + i];
      px[at] = lut[(b >> 6) & 3];
      px[at + 1] = lut[(b >> 4) & 3];
      px[at + 2] = lut[(b >> 2) & 3];
      px[at + 3] = lut[b & 3];
      at += 4;
    }
  }
}

/** Mode 4 — 256x192, four bits per pixel, high nibble leftmost. */
function mode4(data: Uint8Array, px: Uint32Array, lut: Uint32Array): void {
  for (let y = 0; y < SSX_HEIGHT; y++) {
    let at = y * SSX_WIDTH;
    const line = y << 7;
    for (let i = 0; i < 128; i++) {
      const b = data[line + i];
      const hi = lut[b >> 4];
      const lo = lut[b & 0x0F];
      px[at] = hi;
      px[at + 1] = hi;
      px[at + 2] = lo;
      px[at + 3] = lo;
      at += 4;
    }
  }
}
