/**
 * Render a ZX Spectrum screen dump to a canvas.
 *
 * Algorithm adapted from damieng/retro-render (SpectrumScreen), using the
 * emulator's own palette (src/cores/ula.ts) so library thumbnails match the live
 * display. Accepts a 6912-byte dump (bitmap + attributes) or a 6144-byte dump
 * (bitmap only — rendered as black ink on white paper).
 *
 * The palette entries are ABGR uint32, which is exactly the little-endian layout
 * of ImageData's pixel buffer, so they're written straight in.
 */

import { PALETTES, vramBitmapAddr, type ColorMap } from '@/machines/spectrum/ula.ts';

export const SCR_WIDTH = 256;
export const SCR_HEIGHT = 192;

const ATTR_OFFSET = 6144;   // 0x1800 — attributes follow the bitmap in a .scr

/**
 * Draw `scr` onto `canvas` (resized to 256×192). Returns false if the data isn't
 * a recognisable SCR dump (caller can then show a fallback).
 */
export function renderScreenToCanvas(scr: Uint8Array, canvas: HTMLCanvasElement, colorMap: ColorMap = 'basic'): boolean {
  if (scr.length < ATTR_OFFSET) return false;
  canvas.width = SCR_WIDTH;
  canvas.height = SCR_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const palette = PALETTES[colorMap];
  const hasAttr = scr.length >= 6912;
  const img = ctx.createImageData(SCR_WIDTH, SCR_HEIGHT);
  const px = new Uint32Array(img.data.buffer);

  for (let y = 0; y < SCR_HEIGHT; y++) {
    const rowAddr = vramBitmapAddr(y) - 0x4000;          // bitmap row offset within the dump
    const attrRow = ATTR_OFFSET + (y >> 3) * 32;
    let out = y * SCR_WIDTH;
    for (let col = 0; col < 32; col++) {
      const bits = scr[rowAddr + col];
      let ink = 0, paper = 7, bright = 0;
      if (hasAttr) {
        const attr = scr[attrRow + col];
        ink = attr & 7;
        paper = (attr >> 3) & 7;
        bright = (attr >> 6) & 1;
      }
      const inkRGBA = palette[ink + (bright ? 8 : 0)];
      const paperRGBA = palette[paper + (bright ? 8 : 0)];
      for (let bit = 7; bit >= 0; bit--) {
        px[out++] = (bits >> bit) & 1 ? inkRGBA : paperRGBA;
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return true;
}
