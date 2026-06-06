/**
 * CPC screen OCR — recover text from the bitmap display.
 *
 * Unlike the Spectrum engine (which heuristically hunts for a font in RAM/ROM),
 * the CPC always renders text through a known 8×8 character set held in the
 * lower OS ROM: 256 glyphs at offset &3800, MSB-first (bit 7 = leftmost pixel).
 * So OCR here is deterministic — decode each character cell's pixels to a 1-bpp
 * glyph (any non-background pen = ink), then match it against that font, trying
 * normal and inverse video.
 *
 * Mode-aware: a text column is always 8 screen pixels wide, but the bytes behind
 * it differ by screen mode. Mode 0 packs 2 px/byte (4 bytes/col → 20 cols),
 * mode 1 packs 4 px/byte (2 bytes/col → 40 cols), mode 2 packs 8 px/byte
 * (1 byte/col → 80 cols). Character rows are 8 rasters tall in every mode.
 *
 * Decoding mirrors GateArray.plotChar exactly so the recovered pixels match what
 * was drawn; the byte addressing mirrors GateArray.renderScanline.
 */

import type { CpcOcrGrid, OcrResult } from './screen-text.ts';

/** Offset of the 256×8-byte character matrix within the 16KB lower OS ROM. */
export const CPC_FONT_OFFSET = 0x3800;

/** Bytes of display RAM behind one 8-pixel text column, per screen mode. */
function bytesPerCol(mode: number): number {
  return mode === 0 ? 4 : mode === 1 ? 2 : 1;
}

/** Text columns across the display for a screen mode and the CRTC's
 *  horizontal-displayed register (R1, counted in CRTC characters = 2 bytes
 *  each). Standard firmware text gives 20 / 40 / 80. */
export function cpcCols(mode: number, hDisplayed: number): number {
  return Math.floor((hDisplayed * 2) / bytesPerCol(mode));
}

/** Grid label for a screen mode (mode 3 is treated as mode 2). */
export function cpcGrid(mode: number): CpcOcrGrid {
  return mode === 0 ? '20x25' : mode >= 2 ? '80x25' : '40x25';
}

/** CPC video byte address for memory-address `ma` (a CRTC character) and raster
 *  line `ra` within the character row. Matches the Gate Array's fetch. */
function videoAddr(ma: number, ra: number): number {
  return (((ma & 0x3000) << 2) | ((ra & 7) << 11) | ((ma & 0x3FF) << 1)) & 0xFFFF;
}

/** Decode one display byte into its logical pens, left→right, written into
 *  `out`. Returns the pen count: mode 0 → 2, mode 1 → 4, mode 2 → 8. */
function decodePens(b: number, mode: number, out: number[]): number {
  if (mode === 0) {
    out[0] = ((b & 0x80) >> 7) | ((b & 0x08) >> 2) | ((b & 0x20) >> 3) | ((b & 0x02) << 2);
    out[1] = ((b & 0x40) >> 6) | ((b & 0x04) >> 1) | ((b & 0x10) >> 2) | ((b & 0x01) << 3);
    return 2;
  }
  if (mode === 1) {
    out[0] = ((b & 0x80) >> 7) | ((b & 0x08) >> 2);
    out[1] = ((b & 0x40) >> 6) | ((b & 0x04) >> 1);
    out[2] = ((b & 0x20) >> 5) | (b & 0x02);
    out[3] = ((b & 0x10) >> 4) | ((b & 0x01) << 1);
    return 4;
  }
  for (let i = 0; i < 8; i++) out[i] = (b >> (7 - i)) & 1;
  return 8;
}

/** Scratch pen buffer for decodePens (single-threaded, synchronous use). */
const penScratch: number[] = new Array(8);

/**
 * Extract one 8×8 character cell into `out` (8 bytes, MSB-first), setting each
 * bit where the pixel uses a non-background (non-zero) pen. Returns the most
 * common non-zero pen in the cell (its ink colour), or -1 if the cell is blank.
 */
function extractCell(
  readVideo: (addr: number) => number,
  mode: number, dispStart: number, hDisplayed: number,
  col: number, row: number, out: Uint8Array,
): number {
  const bpc = bytesPerCol(mode);
  const maRow = (dispStart + row * hDisplayed) & 0x3FFF;
  const startByte = col * bpc;
  const penCount = new Uint16Array(16);

  for (let p = 0; p < 8; p++) {
    let glyph = 0;
    let bit = 7;
    for (let k = 0; k < bpc; k++) {
      const byteIndex = startByte + k;
      const ch = byteIndex >> 1;          // CRTC character (2 bytes wide)
      const half = byteIndex & 1;         // even = b0, odd = b1
      const ma = (maRow + ch) & 0x3FFF;
      const b = readVideo(videoAddr(ma, p) + half) & 0xFF;
      const n = decodePens(b, mode, penScratch);
      for (let i = 0; i < n; i++) {
        const pen = penScratch[i];
        if (pen !== 0) { glyph |= (1 << bit); penCount[pen & 0x0F]++; }
        bit--;
      }
    }
    out[p] = glyph;
  }

  let inkPen = -1, best = 0;
  for (let pen = 1; pen < 16; pen++) {
    if (penCount[pen] > best) { best = penCount[pen]; inkPen = pen; }
  }
  return inkPen;
}

/** Match an 8-byte glyph against the CPC font; printable ASCII 0x20–0x7E, both
 *  normal and inverse video. Returns the character code, or -1 if unrecognised.
 *  A blank glyph matches space (0x20). */
function matchGlyph(glyph: Uint8Array, font: Uint8Array): number {
  for (let inv = 0; inv < 2; inv++) {
    for (let c = 0x20; c <= 0x7E; c++) {
      const fb = c << 3;
      let ok = true;
      for (let p = 0; p < 8; p++) {
        const f = inv ? (font[fb + p] ^ 0xFF) & 0xFF : font[fb + p] & 0xFF;
        if (glyph[p] !== f) { ok = false; break; }
      }
      if (ok) return c;
    }
  }
  return -1;
}

/** ABGR (0xAABBGGRR, the packed word the renderers use) → CSS #rrggbb. */
function abgrToHex(abgr: number): string {
  const r = abgr & 0xFF;
  const g = (abgr >>> 8) & 0xFF;
  const b = (abgr >>> 16) & 0xFF;
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function escapeHtml(ch: string): string {
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '&') return '&amp;';
  return ch;
}

/** Inputs describing the CPC display to OCR. */
export interface CpcOcrInput {
  readVideo: (addr: number) => number;
  mode: number;
  dispStart: number;
  hDisplayed: number;
  rows: number;
  /** 256-glyph (≥2048 byte) MSB-first font, e.g. lower ROM @ &3800. */
  font: Uint8Array;
}

/**
 * The CPC OCR engine. Holds an `active` flag for the UI overlay (mirroring the
 * Spectrum's ScreenText); the OCR itself always runs when called.
 */
export class CpcScreenText {
  active = false;
  activate(): void { this.active = true; }
  deactivate(): void { this.active = false; }

  /** OCR the screen to plain text (rows separated by newlines). */
  ocr(input: CpcOcrInput): string {
    const { readVideo, mode, dispStart, hDisplayed, rows, font } = input;
    const cols = cpcCols(mode, hDisplayed);
    const glyph = new Uint8Array(8);
    let text = '';
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        extractCell(readVideo, mode, dispStart, hDisplayed, col, row, glyph);
        const c = matchGlyph(glyph, font);
        text += c < 0 ? ' ' : String.fromCharCode(c);
      }
      if (row < rows - 1) text += '\n';
    }
    return text;
  }

  /**
   * OCR the screen to text + coloured HTML + a per-cell match mask. The mask
   * marks recognised, non-space cells (the ones the overlay should blank in the
   * framebuffer so the crisp overlay glyph replaces the bitmap). `pens` is the
   * Gate Array's 17-entry pen→hardware-colour table; `palette` is CPC_PALETTE.
   */
  ocrStyled(input: CpcOcrInput, pens: Uint8Array, palette: Uint32Array): OcrResult {
    const { readVideo, mode, dispStart, hDisplayed, rows, font } = input;
    const cols = cpcCols(mode, hDisplayed);
    const glyph = new Uint8Array(8);
    const mask: boolean[] = new Array(cols * rows);
    let text = '';
    let html = '';
    let spanOpen = false;
    let curHex = '';

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        const inkPen = extractCell(readVideo, mode, dispStart, hDisplayed, col, row, glyph);
        const c = matchGlyph(glyph, font);
        const ch = c < 0 ? null : String.fromCharCode(c);
        text += ch ?? ' ';
        const matched = ch !== null && ch !== ' ';
        mask[idx] = matched;

        if (!matched) {
          if (spanOpen) { html += '</span>'; spanOpen = false; curHex = ''; }
          html += ' ';
          continue;
        }
        const hex = abgrToHex(palette[pens[inkPen < 0 ? 1 : inkPen] & 0x1F]);
        if (hex !== curHex) {
          if (spanOpen) html += '</span>';
          html += `<span style="color:${hex}">`;
          curHex = hex;
          spanOpen = true;
        }
        html += escapeHtml(ch!);
      }
      if (spanOpen) { html += '</span>'; spanOpen = false; curHex = ''; }
      if (row < rows - 1) { text += '\n'; html += '\n'; }
    }

    return {
      text, html, mask,
      grid: cpcGrid(mode), cellWidth: 8, cellHeight: 8, cols, rows,
    };
  }
}
