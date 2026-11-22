/**
 * Screen dump formats beyond the plain 6912-byte `.scr`: the Timex Computer
 * 2048's two-screen modes and the multicolour (one attribute per 8x1 line)
 * pictures many demos and games use.
 *
 * File layouts (all bitmaps are in the Spectrum's interleaved screen layout):
 *   .scr  6144   bitmap only (black on white)
 *   .scr  6912   bitmap, then 768 attributes (the usual dump)
 *   .scr 12288   Timex hi-colour: the bitmap, then 6144 attribute bytes, one per
 *                8x1 pixels, laid out like the bitmap (so it is screens 0 and 1)
 *   .scr 12289   Timex hi-res: screen 0, screen 1, then one byte for port 0xFF
 *                (bits 3-5 give the hi-res colour); 512x192
 *   .mlt 12288   multicolour: the bitmap, then 6144 attribute bytes, one per
 *                8x1 pixels, in plain line order (32 a line, no interleave)
 *
 * Reading is a plain decode of the bytes to pixels (no emulation involved); the
 * tests hold it against what the emulator's ULA draws from the same screen memory.
 */

import { PALETTES, vramBitmapAddr } from '@/machines/spectrum/ula.ts';

export type ScreenExtension = 'scr' | 'mlt';

export const SCR_BITMAP_SIZE = 6144;
export const SCR_STANDARD_SIZE = 6912;
export const SCR_TWO_SCREENS_SIZE = 12288;
export const SCR_HIRES_SIZE = 12289;

/** Offset of screen 1 within the 16K display bank (0x6000 - 0x4000), which the
 *  export side reads from. */
const SCREEN_1 = 0x2000;
/** Offset of the 8x8 attribute area within a screen. */
const ATTRS = 0x1800;

/** Offset within a screen of pixel row `y`, character column 0. */
const rowOffset = (y: number): number => vramBitmapAddr(y) - 0x4000;

/** A decoded picture: RGBA pixels (ABGR words in little-endian byte order). */
export interface DecodedScreen {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * Pixels of a dump larger than a standard one (see the layouts above), or null
 * when it is not one (a standard dump is drawn the usual way). `palette` is one
 * of the ULA's 16-entry palettes. The result is 256x192, or 512x192 for hi-res.
 * FLASH is left in its normal state, as in a still picture.
 */
export function decodeExtendedScreen(
  data: Uint8Array, ext: ScreenExtension, palette: Uint32Array = PALETTES.basic,
): DecodedScreen | null {
  if (ext === 'scr' && data.length === SCR_HIRES_SIZE) return decodeHiRes(data, palette);
  if (data.length === SCR_TWO_SCREENS_SIZE) return decodeLineAttributes(data, ext, palette);
  return null;
}

/** 256x192: the bitmap, and an attribute for each 8x1 run of pixels. */
function decodeLineAttributes(data: Uint8Array, ext: ScreenExtension, palette: Uint32Array): DecodedScreen {
  const pixels = new Uint8Array(256 * 192 * 4);
  const out = new Uint32Array(pixels.buffer);
  for (let y = 0; y < 192; y++) {
    const row = rowOffset(y);
    for (let col = 0; col < 32; col++) {
      const bits = data[row + col];
      // A .scr holds the attributes laid out like the bitmap; an .mlt in plain line order.
      const attr = data[SCR_BITMAP_SIZE + (ext === 'scr' ? row + col : y * 32 + col)];
      const bright = (attr & 0x40) !== 0 ? 8 : 0;
      const ink = palette[(attr & 7) + bright];
      const paper = palette[((attr >> 3) & 7) + bright];
      let at = y * 256 + col * 8;
      for (let bit = 7; bit >= 0; bit--) out[at++] = (bits >> bit) & 1 ? ink : paper;
    }
  }
  return { width: 256, height: 192, pixels };
}

/** 512x192: screen 0's and screen 1's bytes alternate along each line, in the
 *  hi-res colour (ink = bits 3-5 of the last byte, paper its complement, bright). */
function decodeHiRes(data: Uint8Array, palette: Uint32Array): DecodedScreen {
  const pixels = new Uint8Array(512 * 192 * 4);
  const out = new Uint32Array(pixels.buffer);
  const colour = (data[SCR_TWO_SCREENS_SIZE] >> 3) & 7;
  const ink = palette[colour + 8];
  const paper = palette[(7 - colour) + 8];
  for (let y = 0; y < 192; y++) {
    const row = rowOffset(y);
    for (let col = 0; col < 32; col++) {
      const left = data[row + col];
      const right = data[SCR_BITMAP_SIZE + row + col];
      let at = y * 512 + col * 16;
      for (let bit = 7; bit >= 0; bit--) out[at++] = (left >> bit) & 1 ? ink : paper;
      for (let bit = 7; bit >= 0; bit--) out[at++] = (right >> bit) & 1 ? ink : paper;
    }
  }
  return { width: 512, height: 192, pixels };
}

/** The screen state an export needs from the machine. */
export interface ScreenState {
  /** Port 0xFF bits 0-2 (0 on a machine without the Timex ULA). */
  timexMode: number;
  /** Port 0xFF bits 3-5: the hi-res ink. */
  hiResInk: number;
  /** Hardware multicolour (the Pentagon 1024's EFF7 bit 5): an attribute per
   *  bitmap byte, 0x2000 above it. */
  perByteAttributes: boolean;
}

const isHiRes = (s: ScreenState): boolean => (s.timexMode & 4) !== 0;
const hasLineAttributes = (s: ScreenState): boolean => !isHiRes(s) && ((s.timexMode & 2) !== 0 || s.perByteAttributes);

/** Offset of the bitmap on show: screen 1 when bit 0 of the mode says so. */
const bitmapBase = (s: ScreenState): number => ((s.timexMode & 1) !== 0 ? SCREEN_1 : 0);

/**
 * A hi-res screen as one linear bitmap: 192 rows of 64 bytes, the pixels of a
 * 512-pixel row in order, left to right. Each pair of bytes is one character
 * column of the display: the first is the left 8 pixels, the second the right.
 * Where the second byte comes from depends on the mode: mode 6 reads screen 1's
 * bitmap, 4 and 5 an attribute-area byte (screen 0's or screen 1's), 7 repeats the
 * first byte; modes 5 and 7 also read their first byte from screen 1.
 */
export function hiResLinear(bank: Uint8Array, timexMode: number): Uint8Array {
  const base = (timexMode & 1) !== 0 ? SCREEN_1 : 0;
  const out = new Uint8Array(64 * 192);
  for (let y = 0; y < 192; y++) {
    for (let col = 0; col < 32; col++) {
      const at = rowOffset(y) + col;
      const cell = ATTRS + (y >> 3) * 32 + col;
      const left = bank[base + at];
      out[y * 64 + col * 2] = left;
      out[y * 64 + col * 2 + 1] = timexMode === 4 ? bank[cell]
        : timexMode === 5 ? bank[SCREEN_1 + cell]
          : timexMode === 6 ? bank[SCREEN_1 + at]
            : left;
    }
  }
  return out;
}

/**
 * The `.scr` for the screen on show, in the size that holds all of it: 6912
 * bytes for an ordinary screen, 12288 for one with an attribute per 8x1 line
 * (Timex hi-colour, Pentagon 1024 multicolour), 12289 for Timex hi-res (written
 * as mode 6 whatever hi-res mode it was in, the two halves of each 16 pixels
 * placed in the two screens, with the hi-res colour in the last byte).
 */
export function encodeScr(bank: Uint8Array, s: ScreenState): Uint8Array {
  const base = bitmapBase(s);
  if (isHiRes(s)) {
    const out = new Uint8Array(SCR_HIRES_SIZE);
    const linear = hiResLinear(bank, s.timexMode);
    for (let y = 0; y < 192; y++) {
      for (let col = 0; col < 32; col++) {
        const at = rowOffset(y) + col;
        out[at] = linear[y * 64 + col * 2];
        out[SCR_BITMAP_SIZE + at] = linear[y * 64 + col * 2 + 1];
      }
    }
    out[SCR_TWO_SCREENS_SIZE] = 0x06 | (s.hiResInk << 3);
    return out;
  }
  if (hasLineAttributes(s)) {
    const out = new Uint8Array(SCR_TWO_SCREENS_SIZE);
    out.set(bank.subarray(base, base + SCR_BITMAP_SIZE), 0);
    out.set(bank.subarray(SCREEN_1, SCREEN_1 + SCR_BITMAP_SIZE), SCR_BITMAP_SIZE);
    return out;
  }
  return bank.slice(base, base + SCR_STANDARD_SIZE);
}

/**
 * The multicolour `.mlt` for the screen on show: the bitmap, then an attribute
 * for every 8x1 line in plain line order. A screen with 8x8 attributes gives each
 * cell's attribute to its eight lines. Null for hi-res, which has no attributes.
 */
export function encodeMlt(bank: Uint8Array, s: ScreenState): Uint8Array | null {
  if (isHiRes(s)) return null;
  const base = bitmapBase(s);
  const out = new Uint8Array(SCR_TWO_SCREENS_SIZE);
  out.set(bank.subarray(base, base + SCR_BITMAP_SIZE), 0);
  const perLine = hasLineAttributes(s);
  for (let y = 0; y < 192; y++) {
    for (let col = 0; col < 32; col++) {
      out[SCR_BITMAP_SIZE + y * 32 + col] = perLine
        ? bank[SCREEN_1 + rowOffset(y) + col]
        : bank[base + ATTRS + (y >> 3) * 32 + col];
    }
  }
  return out;
}
