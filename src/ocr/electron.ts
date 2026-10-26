/**
 * Acorn Electron screen OCR.
 *
 * The OS prints text in every mode by plotting 8×8 glyphs from its character
 * font (the BBC's 96-character set, 32-127, MSB leftmost). A character is 8
 * pixels wide, so it spans 1, 2 or 4 display bytes at 1, 2 or 4 bits per pixel.
 * Each cell is decoded to the ULA's logical colours, split into paper (the
 * majority corner colour) and ink, and the one-bit glyph matched against the
 * font in normal and inverse video.
 *
 * Display memory is cell-major: each byte column of a character row is eight
 * consecutive bytes (one per scanline), and a row of characters is a whole
 * line's worth of byte columns (640 bytes in modes 0-3, 320 in modes 4-6).
 */

import type { BbcOcrGrid, OcrResult } from './ocr.ts';

const MODE_SIZE = [0x5000, 0x5000, 0x5000, 0x4000, 0x2800, 0x2800, 0x2000, 0x2000];
const MODE_BPP = [1, 2, 4, 1, 1, 2, 1, 1];
/** Characters across the screen, by mode. */
export const ELECTRON_MODE_COLS = [80, 40, 20, 80, 40, 20, 40, 40] as const;
/** Character rows: the gapped text modes 3 and 6 are 25 rows, the rest 32. */
export const ELECTRON_MODE_ROWS = [32, 32, 32, 25, 32, 32, 25, 25] as const;

export const ELECTRON_FONT_BYTES = 96 * 8;

export interface ElectronOcrInput {
  /** 32K main RAM (addresses == indices). */
  ram: Uint8Array;
  /** ULA screen start address. */
  screenStart: number;
  /** Display mode 0-7 (7 behaves as 6). */
  mode: number;
  /** OS font: characters 32-127, 8 bytes each (see {@link findElectronFont}). */
  font: Uint8Array;
  /** Colour index (r | g<<1 | b<<2) of each of the 16 palette pens. */
  pens: Uint8Array;
  /** Colour index → packed ABGR. */
  palette: Uint32Array;
}

/** Locate the 96-character font in an OS ROM. The table is the BBC's: it starts
 *  with a blank space glyph followed by `!` (18 18 18 18 18 00 18 00) and `"`
 *  (6C 6C 6C 00 …). Returns a zeroed table when it can't be found. */
export function findElectronFont(os: Uint8Array): Uint8Array {
  const sig = [0, 0, 0, 0, 0, 0, 0, 0, 0x18, 0x18, 0x18, 0x18, 0x18, 0x00, 0x18, 0x00,
    0x6C, 0x6C, 0x6C, 0, 0, 0, 0, 0];
  outer: for (let i = 0; i + ELECTRON_FONT_BYTES <= os.length; i++) {
    for (let j = 0; j < sig.length; j++) if (os[i + j] !== sig[j]) continue outer;
    return os.subarray(i, i + ELECTRON_FONT_BYTES);
  }
  return new Uint8Array(ELECTRON_FONT_BYTES);
}

function abgrToHex(abgr: number): string {
  const r = abgr & 0xFF, g = (abgr >> 8) & 0xFF, b = (abgr >> 16) & 0xFF;
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function escapeHtml(ch: string): string {
  return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
}

/** Pen index of each pixel of a display byte, left to right (the ULA's bit interleave). */
function decodeByte(byte: number, bpp: number, out: Uint8Array, at: number): void {
  const n = 8 / bpp;
  for (let p = 0; p < n; p++) {
    const d = byte << p;
    out[at + p] = bpp === 1 ? (d >> 4) & 8
      : bpp === 2 ? ((d >> 4) & 8) | ((d >> 2) & 2)
        : ((d >> 4) & 8) | ((d >> 3) & 4) | ((d >> 2) & 2) | ((d >> 1) & 1);
  }
}

const cell = new Uint8Array(64);
const glyph = new Uint8Array(8);

/** Decode a character cell into `glyph`; returns [ink, paper] pen indices. */
function extractCell(input: ElectronOcrInput, col: number, row: number): [number, number] {
  const mode = input.mode & 7;
  const bpp = MODE_BPP[mode];
  const pitch = (mode & 4 ? 40 : 80) * 8;
  const size = MODE_SIZE[mode];
  const counts = new Uint16Array(16);
  for (let ra = 0; ra < 8; ra++) {
    for (let k = 0; k < bpp; k++) {
      let addr = input.screenStart + row * pitch + (col * bpp + k) * 8 + ra;
      while (addr & 0x8000) addr -= size;
      decodeByte(input.ram[addr & 0x7FFF], bpp, cell, ra * 8 + k * (8 / bpp));
    }
    for (let x = 0; x < 8; x++) counts[cell[ra * 8 + x]]++;
  }
  const corner = new Uint8Array(16);
  corner[cell[0]]++; corner[cell[7]]++; corner[cell[56]]++; corner[cell[63]]++;
  let paper = 0, best = -1;
  for (let c = 0; c < 16; c++) if (corner[c] > best) { best = corner[c]; paper = c; }
  let ink = -1, inkBest = 0;
  for (let c = 0; c < 16; c++) if (c !== paper && counts[c] > inkBest) { inkBest = counts[c]; ink = c; }
  for (let ra = 0; ra < 8; ra++) {
    let g = 0;
    for (let x = 0; x < 8; x++) if (cell[ra * 8 + x] !== paper) g |= 0x80 >> x;
    glyph[ra] = g;
  }
  return [ink, paper];
}

/** Match `glyph` against the font (normal, then inverse video). Returns the
 *  character code, or -1. A blank cell matches space. */
function matchGlyph(font: Uint8Array): number {
  for (let inv = 0; inv < 2; inv++) {
    for (let c = 0; c < 96; c++) {
      let ok = true;
      for (let p = 0; p < 8; p++) {
        const f = inv ? font[c * 8 + p] ^ 0xFF : font[c * 8 + p];
        if (glyph[p] !== f) { ok = false; break; }
      }
      if (ok) return 32 + c;
    }
  }
  return -1;
}

function electronChar(code: number): string {
  if (code === 96) return '£';
  if (code === 127) return ' ';
  return String.fromCharCode(code);
}

/** Transcribe a screen. The paper returned per cell is a physical colour (0-7)
 *  so the machine can blank matched cells to it. */
export function ocrElectronBitmap(input: ElectronOcrInput): OcrResult {
  const mode = input.mode & 7;
  const cols = ELECTRON_MODE_COLS[mode];
  const rows = ELECTRON_MODE_ROWS[mode];
  const mask: boolean[] = new Array(cols * rows);
  const paper: number[] = new Array(cols * rows);
  let text = '', html = '';
  let spanOpen = false, curHex = '';
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const [ink, pap] = extractCell(input, col, row);
      paper[idx] = input.pens[pap] & 7;
      const code = matchGlyph(input.font);
      const ch = code < 0 ? ' ' : electronChar(code);
      text += ch;
      const matched = ch !== ' ';
      mask[idx] = matched;
      if (!matched) {
        if (spanOpen) { html += '</span>'; spanOpen = false; curHex = ''; }
        html += ' ';
        continue;
      }
      const hex = abgrToHex(input.palette[input.pens[ink < 0 ? pap : ink] & 7]);
      if (hex !== curHex) {
        if (spanOpen) html += '</span>';
        html += `<span style="color:${hex}">`;
        curHex = hex;
        spanOpen = true;
      }
      html += escapeHtml(ch);
    }
    if (spanOpen) { html += '</span>'; spanOpen = false; curHex = ''; }
    if (row < rows - 1) { text += '\n'; html += '\n'; }
  }
  return {
    text, html, mask, paper,
    grid: `${cols}x${rows}` as BbcOcrGrid,
    cellWidth: 8, cellHeight: 8, cols, rows,
  };
}
