/**
 * BBC Micro screen-text OCR (Mode 7 teletext).
 *
 * In Mode 7 the screen is not a pixel grid to be recognised but a 40×25 array
 * of SAA5050 display bytes fetched through the 6845's MA — so transcription is
 * a read, exactly like the Jupiter Ace. Each byte's low seven bits are the
 * teletext character code (bit 7 is the flash attribute); the ROM renderer in
 * `machines/bbc/bbc-video.ts` masks to seven bits, and this engine mirrors it:
 *
 *   0x00-0x1F  control codes — recolor the fg/bg, select alpha vs mosaic;
 *              they draw nothing, so they read as blank cells.
 *   0x20-0x7E  the ASCII/teletext G0 set, read through to text.
 *   0x7F       DEL, blank.
 *   graphic    while the SAA5050 is in mosaic mode every display byte draws
 *              block graphics, not text — those cells read as blank.
 *
 * Colour state carries left-to-right and row-to-row within the field, so the
 * state machine below tracks fg/bg/graphics exactly as the SAA5050 core does.
 *
 * Bitmap modes 0-6 are recognised instead (see `BbcBitmapText` below): each
 * character cell is decoded back to an 8×8 glyph and matched against the MOS
 * font, as the CPC engine does.
 *
 * Consumed by the MCP `ocr` tool via `BbcMachine.ocrScreenForMcp` and by the
 * TEXT overlay through the BBC frame probe's transcribe driver.
 */

import type { BbcOcrGrid, OcrGridName, OcrResult } from './ocr.ts';

/** Mode 7 teletext window, in display bytes. */
export const BBC_MODE7_COLS = 40;
export const BBC_MODE7_ROWS = 25;
/** One SAA5050 cell, already doubled to 12×20 pixels by the chip core. */
export const BBC_MODE7_CELL_W = 12;
export const BBC_MODE7_CELL_H = 20;
/** Top-left of the teletext window within the 640×512 active picture — the
 *  same centring `BbcVideo.renderTeletext` uses (the machine adds its border). */
export const BBC_MODE7_ORIGIN_X = (640 - BBC_MODE7_COLS * BBC_MODE7_CELL_W) >> 1;
export const BBC_MODE7_ORIGIN_Y = (512 - BBC_MODE7_ROWS * BBC_MODE7_CELL_H) >> 1;
/** Grid label stamped on the result. */
export const BBC_MODE7_GRID: OcrGridName = '40x25';

/** Teletext address translation from the 6845 MA: bit 11 selects the 0x7C00
 *  block and bit 10 is ignored. Mirrors `teletextAddr` in `bbc-video.ts`. */
export function teletextAddr(ma: number): number {
  return (0x3C00 | ((ma & 0x0800) << 3) | (ma & 0x03FF)) & 0x7FFF;
}

/** The state the SAA5050 carries across a field's display bytes. */
interface TeletextState {
  fg: number;
  bg: number;
  graphics: boolean;
}

function resetState(s: TeletextState): void {
  s.fg = 7;
  s.bg = 0;
  s.graphics = false;
}

/** Apply a control code (0x00-0x1F), mirroring `Saa5050.applyControl`. */
function applyControl(s: TeletextState, c: number): void {
  if (c >= 0x1C) {
    if (c === 0x1C) s.bg = 0;          // black background
    else if (c === 0x1D) s.bg = s.fg;  // new background
    // 0x1E/0x1F hold/release mosaics affect only the mosaic glyph, which reads
    // as blank either way — nothing for the text state to track.
    return;
  }
  s.fg = c & 7;
  s.graphics = (c & 0x08) !== 0;
}

/** Inputs describing the Mode 7 display to transcribe. */
export interface BbcOcrInput {
  /** 32KB main RAM (addresses == indices). */
  ram: Uint8Array;
  /** 6845 display start address (R12/R13). */
  displayStart: number;
  /** 6845 R1 — MA units advanced per displayed row (40 in Mode 7). */
  stride: number;
  /** Active 8-entry BBC physical palette, packed ABGR (0xAABBGGRR), for HTML. */
  palette: Uint32Array;
}

/** ABGR (0xAABBGGRR) → CSS #rrggbb. */
function abgrToHex(abgr: number): string {
  const r = abgr & 0xFF, g = (abgr >>> 8) & 0xFF, b = (abgr >>> 16) & 0xFF;
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function escapeHtml(ch: string): string {
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '&') return '&amp;';
  return ch;
}

/** Decode the whole field. When `styled` is false the colour/mask work is
 *  skipped and only the text rows are built. */
function decode(
  input: BbcOcrInput, styled: boolean,
): { text: string; html: string; mask: boolean[]; paper: number[] } {
  const { ram, displayStart, stride, palette } = input;
  const cols = BBC_MODE7_COLS, rows = BBC_MODE7_ROWS;
  const state: TeletextState = { fg: 7, bg: 0, graphics: false };
  resetState(state);

  const mask: boolean[] = styled ? new Array(cols * rows) : [];
  const paper: number[] = styled ? new Array(cols * rows) : [];
  let text = '', html = '';
  let spanOpen = false, curHex = '';

  for (let row = 0; row < rows; row++) {
    const maRow = displayStart + row * (stride || cols);
    for (let col = 0; col < cols; col++) {
      const byte = ram[teletextAddr(maRow + col)] & 0xFF;
      const code = byte & 0x7F;
      let ch = ' ';

      if (code < 0x20) {
        applyControl(state, code);
      } else if (state.graphics) {
        ch = ' ';                        // mosaic — no text meaning
      } else if (code === 0x7F) {
        ch = ' ';
      } else {
        ch = String.fromCharCode(code);
      }

      text += ch;
      if (!styled) continue;

      const idx = row * cols + col;
      const matched = ch !== ' ';
      mask[idx] = matched;
      paper[idx] = state.bg;
      if (!matched) {
        if (spanOpen) { html += '</span>'; spanOpen = false; curHex = ''; }
        html += ' ';
        continue;
      }
      const hex = abgrToHex(palette[state.fg & 7]);
      if (hex !== curHex) {
        if (spanOpen) html += '</span>';
        html += `<span style="color:${hex}">`;
        curHex = hex;
        spanOpen = true;
      }
      html += escapeHtml(ch);
    }
    if (spanOpen) { html += '</span>'; spanOpen = false; curHex = ''; }
    if (row < rows - 1) text += '\n';
    if (styled && row < rows - 1) html += '\n';
  }

  return { text, html, mask, paper };
}

/**
 * The BBC Mode 7 screen-text engine. Holds an `active` flag for the TEXT
 * overlay (mirroring the other machines' ScreenText classes); the OCR itself
 * always runs when called.
 */
export class BbcScreenText {
  active = false;
  activate(): void { this.active = true; }
  deactivate(): void { this.active = false; }

  /** Transcribe the field to plain text (rows separated by newlines, trailing
   *  blanks trimmed). Used by the MCP `ocr` tool. */
  ocr(input: BbcOcrInput): string {
    const rows = decode(input, false).text.split('\n').map((r) => r.replace(/\s+$/, ''));
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  }

  /** Styled transcription (text + coloured HTML + match mask + paper pens) for
   *  the TEXT overlay. The mask marks recognised, non-space cells so the
   *  driver can blank the bitmap glyph underneath and let the crisp overlay
   *  text take its place. */
  ocrStyled(input: BbcOcrInput): OcrResult {
    const { text, html, mask, paper } = decode(input, true);
    return {
      text, html, mask, paper,
      grid: BBC_MODE7_GRID,
      cellWidth: BBC_MODE7_CELL_W,
      cellHeight: BBC_MODE7_CELL_H,
      cols: BBC_MODE7_COLS,
      rows: BBC_MODE7_ROWS,
    };
  }
}

// ── Bitmap modes 0-6 ────────────────────────────────────────────────────────
//
// The MOS prints text in the bitmap modes by plotting 8×8 glyphs from its font
// (OS 1.20: characters 32-127 at &C000, MSB = leftmost pixel). A character is
// always 8 pixels wide, so it spans 1, 2 or 4 display bytes at 1, 2 or 4 bits
// per pixel. Each cell is decoded to its logical colours, split into paper
// (the majority corner colour) and ink, and the 1-bit glyph matched against the
// font in normal and inverse video.

/** Size of the MOS 1.20 font: characters 32-127, eight bytes each. */
export const BBC_FONT_BYTES = 96 * 8;

/** Inputs describing a bitmap-mode display. */
export interface BbcBitmapOcrInput {
  /** 32KB main RAM (addresses == indices). */
  ram: Uint8Array;
  /** 6845 display start address (R12/R13). */
  displayStart: number;
  /** 6845 R1 — MA units (display bytes per scanline / 8) per row. */
  stride: number;
  /** 6845 R6 — character rows displayed. */
  rows: number;
  /** Bits per pixel for the mode (1, 2 or 4). */
  bpp: 1 | 2 | 4;
  /** Amount subtracted from an address that overruns 0x7FFF (hardware scroll). */
  wrapSubtract: number;
  /** MOS font: characters 32-127, 8 bytes each (the first 768 bytes of the OS ROM). */
  font: Uint8Array;
  /** Logical → physical colour map (the Video ULA palette). */
  logicalToPhysical: Uint8Array;
  /** Active 8-entry physical palette, packed ABGR, for HTML. */
  palette: Uint32Array;
}

/** Characters per row for a bitmap mode. */
export function bbcBitmapCols(stride: number, bpp: 1 | 2 | 4): number {
  return Math.floor(stride / bpp);
}

/** Pixel colours of one display byte, left→right (the ULA's bit interleave;
 *  mirrors `BbcVideo.renderBitmap`). */
function decodeByte(byte: number, bpp: number, out: Uint8Array, at: number): void {
  const n = 8 / bpp;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let j = 0; j < bpp; j++) v = (v << 1) | ((byte >> ((bpp - 1 - j) * n + (n - 1 - i))) & 1);
    out[at + i] = v;
  }
}

const cellScratch = new Uint8Array(64);
const glyphScratch = new Uint8Array(8);

/** Decode a cell into `glyphScratch`; returns [inkLogical, paperLogical]. */
function extractBitmapCell(input: BbcBitmapOcrInput, col: number, row: number): [number, number] {
  const { ram, displayStart, stride, bpp, wrapSubtract } = input;
  const maRow = displayStart + row * stride;
  const counts = new Uint16Array(16);
  for (let ra = 0; ra < 8; ra++) {
    for (let k = 0; k < bpp; k++) {
      const ma = maRow + col * bpp + k;
      let addr = ((ma & 0x1FFF) << 3) | ra;
      if (ma & 0x1000) addr = (addr - wrapSubtract) & 0x7FFF;
      decodeByte(ram[addr & 0x7FFF], bpp, cellScratch, ra * 8 + k * (8 / bpp));
    }
    for (let x = 0; x < 8; x++) counts[cellScratch[ra * 8 + x]]++;
  }
  const corner = new Uint8Array(16);
  corner[cellScratch[0]]++; corner[cellScratch[7]]++;
  corner[cellScratch[56]]++; corner[cellScratch[63]]++;
  let paper = 0, best = -1;
  for (let c = 0; c < 16; c++) if (corner[c] > best) { best = corner[c]; paper = c; }
  let ink = -1, inkBest = 0;
  for (let c = 0; c < 16; c++) if (c !== paper && counts[c] > inkBest) { inkBest = counts[c]; ink = c; }
  for (let ra = 0; ra < 8; ra++) {
    let g = 0;
    for (let x = 0; x < 8; x++) if (cellScratch[ra * 8 + x] !== paper) g |= 0x80 >> x;
    glyphScratch[ra] = g;
  }
  return [ink, paper];
}

/** Match `glyphScratch` against the font (normal, then inverse video). Returns
 *  the character code, or -1. A blank cell matches space. */
function matchBitmapGlyph(font: Uint8Array): number {
  for (let inv = 0; inv < 2; inv++) {
    for (let c = 0; c < 96; c++) {
      let ok = true;
      for (let p = 0; p < 8; p++) {
        const f = inv ? font[c * 8 + p] ^ 0xFF : font[c * 8 + p];
        if (glyphScratch[p] !== f) { ok = false; break; }
      }
      if (ok) return 32 + c;
    }
  }
  return -1;
}

/** The BBC's font puts '£' at code 96 (the backtick position). */
function bbcChar(code: number): string {
  if (code === 96) return '£';
  if (code === 127) return ' ';
  return String.fromCharCode(code);
}

/** Transcribe a bitmap-mode screen. The paper returned per cell is a physical
 *  colour (0-7) so the machine can blank matched cells to it. */
export function ocrBbcBitmap(input: BbcBitmapOcrInput): OcrResult {
  const cols = bbcBitmapCols(input.stride, input.bpp);
  const rows = input.rows;
  const mask: boolean[] = new Array(cols * rows);
  const paper: number[] = new Array(cols * rows);
  let text = '', html = '';
  let spanOpen = false, curHex = '';
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const [ink, pap] = extractBitmapCell(input, col, row);
      paper[idx] = input.logicalToPhysical[pap] & 7;
      const code = matchBitmapGlyph(input.font);
      const ch = code < 0 ? ' ' : bbcChar(code);
      text += ch;
      const matched = ch !== ' ';
      mask[idx] = matched;
      if (!matched) {
        if (spanOpen) { html += '</span>'; spanOpen = false; curHex = ''; }
        html += ' ';
        continue;
      }
      const hex = abgrToHex(input.palette[input.logicalToPhysical[ink < 0 ? pap : ink] & 7]);
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
