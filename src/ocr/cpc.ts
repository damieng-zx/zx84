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

import type { CpcOcrGrid, OcrResult } from './spectrum.ts';

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

/** Scratch 8×8 pen grid for extractCell ([row*8 + x], single-threaded use). */
const cellPenScratch = new Uint8Array(64);

/** Paper pen of the cell most recently passed to extractCell. Single-threaded;
 *  read immediately after the call (mirrors the scratch buffers above). Used by
 *  ocrStyled to record each cell's background colour for the overlay. */
let extractedPaperPen = 0;

/**
 * Extract one 8×8 character cell into `out` (8 bytes, MSB-first). Returns the
 * cell's ink pen (its colour), or -1 if the cell is blank; the cell's paper pen
 * is left in `extractedPaperPen`.
 *
 * A CPC text cell is two-toned: glyph pixels are drawn in the current PEN (ink)
 * and the rest in the current PAPER (background). PAPER is *not* necessarily pen
 * 0 — `PAPER n` is common — so the background can't be hard-coded. We take the
 * paper to be the most common pen among the cell's four corners: corners are
 * background in any ordinary text glyph, so the majority corner pen reads the
 * paper without being fooled by an ink-heavy centre. A glyph bit is then set
 * wherever a pixel differs from that paper. (Picking the wrong pen merely
 * inverts the cell, which matchGlyph's inverse-video pass already recovers.)
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

  // First pass: decode every pixel's pen into the cell grid and tally counts.
  for (let p = 0; p < 8; p++) {
    let x = 0;
    for (let k = 0; k < bpc; k++) {
      const byteIndex = startByte + k;
      const ch = byteIndex >> 1;          // CRTC character (2 bytes wide)
      const half = byteIndex & 1;         // even = b0, odd = b1
      const ma = (maRow + ch) & 0x3FFF;
      const b = readVideo(videoAddr(ma, p) + half) & 0xFF;
      const n = decodePens(b, mode, penScratch);
      for (let i = 0; i < n; i++) {
        const pen = penScratch[i] & 0x0F;
        cellPenScratch[p * 8 + x] = pen;
        penCount[pen]++;
        x++;
      }
    }
  }

  // Paper = the pen that occurs most often across the four corners (grid indices
  // 0, 7, 56, 63 — top-left/right, bottom-left/right). Ties resolve to the lower
  // pen index.
  const cornerCount = new Uint8Array(16);
  cornerCount[cellPenScratch[0]]++;
  cornerCount[cellPenScratch[7]]++;
  cornerCount[cellPenScratch[56]]++;
  cornerCount[cellPenScratch[63]]++;
  let paperPen = 0, paperBest = -1;
  for (let pen = 0; pen < 16; pen++) {
    if (cornerCount[pen] > paperBest) { paperBest = cornerCount[pen]; paperPen = pen; }
  }
  extractedPaperPen = paperPen;

  // Second pass: a glyph bit is set where the pixel differs from the paper.
  for (let p = 0; p < 8; p++) {
    let glyph = 0;
    for (let x = 0; x < 8; x++) {
      if (cellPenScratch[p * 8 + x] !== paperPen) glyph |= (1 << (7 - x));
    }
    out[p] = glyph;
  }

  // Ink = the most common non-paper pen (the cell's foreground colour).
  let inkPen = -1, inkBest = 0;
  for (let pen = 0; pen < 16; pen++) {
    if (pen !== paperPen && penCount[pen] > inkBest) { inkBest = penCount[pen]; inkPen = pen; }
  }
  return inkPen;
}

/**
 * The full Amstrad CPC character set as Unicode, indexed by font code.
 * Codes 0x20–0x7E are standard ASCII except 0x5E (↑ on the CPC; the caret lives
 * at 0xA0). The control-code region (0x00–0x1F) and high range (0x80–0xFF) hold
 * the firmware's symbols, box/block graphics, Greek letters and arrows. A few
 * codes have no Unicode equivalent (e.g. the blank mosaic 0x80, DEL checker
 * 0x7F) and are left empty so they don't match.
 * Source: https://en.wikipedia.org/wiki/Amstrad_CPC_character_set
 */
const CPC_CHARS: readonly string[] = (() => {
  const t = new Array<string>(256).fill('');
  for (let c = 0x20; c <= 0x7E; c++) t[c] = String.fromCharCode(c);
  const map: Record<number, string> = {
    // 0x00–0x1F — control-code glyphs
    0x00: '◻', 0x01: '⎾', 0x02: '⏊', 0x03: '⏌', 0x04: '⚡', 0x05: '⊠', 0x06: '✓', 0x07: '⍾',
    0x08: '←', 0x09: '→', 0x0A: '↓', 0x0B: '↑', 0x0C: '↡', 0x0D: '↲', 0x0E: '⊗', 0x0F: '⊙',
    0x10: '⊟', 0x11: '◷', 0x12: '◶', 0x13: '◵', 0x14: '◴', 0x15: '⍻', 0x16: '⎍', 0x17: '⊣',
    0x18: '⧖', 0x19: '⍿', 0x1A: '␦', 0x1B: '⊖', 0x1C: '◰', 0x1D: '◱', 0x1E: '◲', 0x1F: '◳',
    // ASCII deviation
    0x5E: '↑',
    // 0x81–0x8F — quadrant/half block mosaics (0x80 is blank → left empty)
    0x81: '▘', 0x82: '▝', 0x83: '▀', 0x84: '▖', 0x85: '▌', 0x86: '▞', 0x87: '▛',
    0x88: '▗', 0x89: '▚', 0x8A: '▐', 0x8B: '▜', 0x8C: '▄', 0x8D: '▙', 0x8E: '▟', 0x8F: '█',
    // 0x90–0x9F — box drawing
    0x90: '·', 0x91: '╵', 0x92: '╶', 0x93: '└', 0x94: '╷', 0x95: '│', 0x96: '┌', 0x97: '├',
    0x98: '╴', 0x99: '┘', 0x9A: '─', 0x9B: '┴', 0x9C: '┐', 0x9D: '┤', 0x9E: '┬', 0x9F: '┼',
    // 0xA0–0xAF — accents, symbols
    0xA0: '^', 0xA1: '´', 0xA2: '¨', 0xA3: '£', 0xA4: '©', 0xA5: '¶', 0xA6: '§', 0xA7: '‘',
    0xA8: '¼', 0xA9: '½', 0xAA: '¾', 0xAB: '±', 0xAC: '÷', 0xAD: '¬', 0xAE: '¿', 0xAF: '¡',
    // 0xB0–0xBF — Greek
    0xB0: 'α', 0xB1: 'β', 0xB2: 'γ', 0xB3: 'δ', 0xB4: 'ε', 0xB5: 'θ', 0xB6: 'λ', 0xB7: 'μ',
    0xB8: 'π', 0xB9: 'σ', 0xBA: 'φ', 0xBB: 'ψ', 0xBC: 'χ', 0xBD: 'ω', 0xBE: 'Σ', 0xBF: 'Ω',
    // 0xC0–0xCF — diagonal/shading
    0xC0: '🮠', 0xC1: '🮡', 0xC2: '🮣', 0xC3: '🮢', 0xC4: '🮧', 0xC5: '🮥', 0xC6: '🮦', 0xC7: '🮤',
    0xC8: '🮨', 0xC9: '🮩', 0xCA: '🮮', 0xCB: '╳', 0xCC: '╱', 0xCD: '╲', 0xCE: '🮕', 0xCF: '▒',
    // 0xD0–0xDF — edges/triangles
    0xD0: '▔', 0xD1: '▕', 0xD2: '▁', 0xD3: '▏', 0xD4: '◤', 0xD5: '◥', 0xD6: '◢', 0xD7: '◣',
    0xD8: '🮎', 0xD9: '🮍', 0xDA: '🮏', 0xDB: '🮌', 0xDC: '🮜', 0xDD: '🮝', 0xDE: '🮞', 0xDF: '🮟',
    // 0xE0–0xEF — pictographs (0xEF has no Unicode → left empty)
    0xE0: '☺', 0xE1: '☹', 0xE2: '♣', 0xE3: '♦', 0xE4: '♥', 0xE5: '♠', 0xE6: '○', 0xE7: '●',
    0xE8: '□', 0xE9: '■', 0xEA: '♂', 0xEB: '♀', 0xEC: '♩', 0xED: '♪', 0xEE: '☼',
    // 0xF0–0xFF — arrows/triangles (0xFC, 0xFD have no Unicode → left empty)
    0xF0: '⭡', 0xF1: '⭣', 0xF2: '⭠', 0xF3: '⭢', 0xF4: '▲', 0xF5: '▼', 0xF6: '▶', 0xF7: '◀',
    0xF8: '🯆', 0xF9: '🯅', 0xFA: '🯇', 0xFB: '🯈', 0xFE: '⭥', 0xFF: '⭤',
  };
  for (const k in map) t[+k] = map[+k];
  return t;
})();

/** Codes matchGlyph attempts: printable ASCII 0x20–0x7E first (so a blank glyph
 *  matches space, and letters/digits always win any glyph collision), then every
 *  other code that has a Unicode mapping, in ascending order. */
const CPC_MATCH_CODES: readonly number[] = (() => {
  const codes: number[] = [];
  for (let c = 0x20; c <= 0x7E; c++) codes.push(c);
  for (let c = 0; c < 256; c++) if ((c < 0x20 || c > 0x7E) && CPC_CHARS[c]) codes.push(c);
  return codes;
})();

/** Map a matched CPC font code to its output character (see CPC_CHARS). */
function cpcCharForCode(c: number): string {
  return CPC_CHARS[c];
}

/** Match an 8-byte glyph against the CPC font, both normal and inverse video.
 *  Returns the matched font code, or -1 if unrecognised. A blank glyph matches
 *  space (0x20). Map the code through cpcCharForCode for the output character. */
function matchGlyph(glyph: Uint8Array, font: Uint8Array): number {
  for (let inv = 0; inv < 2; inv++) {
    for (const c of CPC_MATCH_CODES) {
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
        text += c < 0 ? ' ' : cpcCharForCode(c);
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
    const paper: number[] = new Array(cols * rows);
    let text = '';
    let html = '';
    let spanOpen = false;
    let curHex = '';

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        const inkPen = extractCell(readVideo, mode, dispStart, hDisplayed, col, row, glyph);
        paper[idx] = extractedPaperPen;
        const c = matchGlyph(glyph, font);
        const ch = c < 0 ? null : cpcCharForCode(c);
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
      text, html, mask, paper,
      grid: cpcGrid(mode), cellWidth: 8, cellHeight: 8, cols, rows,
    };
  }
}
