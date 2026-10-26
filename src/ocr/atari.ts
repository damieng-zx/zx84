/**
 * Atari 8-bit screen-text OCR.
 *
 * Like the MSX, the Atari keeps character *codes* in screen memory, so text is
 * read directly rather than matched against glyphs. What the Atari adds is the
 * display list: there is no fixed text screen, only ANTIC instructions that
 * say which scanlines show which mode from which address. So the engine walks
 * the display list the way ANTIC does (blank runs, LMS, JVB, the memory scan
 * counter advancing by each mode line's fetch, wrapping within 4K) and decodes
 * every text mode line:
 *
 *   modes 2-5  40 characters (at the normal width), 7-bit code + inverse bit
 *   modes 6-7  20 characters, 6-bit code + 2 colour bits; CHBASE bit 1 picks
 *              the upper (lower-case/graphics) half of the set
 *
 * Screen codes are ANTIC's internal order, not ATASCII: internal $00-$3F is
 * ATASCII $20-$5F (space, punctuation, digits, capitals), $40-$5F the
 * graphics characters, $60-$7F lower case. Graphics characters read as
 * spaces, except the few with an obvious text equivalent.
 *
 * Programs often bring their own font, so the code alone is not trusted. The
 * glyph each code shows is looked at too: a blank glyph reads as a space; a
 * glyph identical to a character of the OS ROM font (at $E000) reads as that
 * character, wherever the program put it; any other glyph keeps its code's
 * reading in the plain text modes (2/3/6/7, where custom fonts usually keep
 * letters in place) and reads as a space in the multicolour modes 4/5, which
 * are nearly always graphics tiles.
 *
 * Two outputs: plain text for every text line on screen (any layout, map-mode
 * lines skipped), and a 40x24 overlay grid for the TEXT mode, which covers
 * the rows that sit on the standard GRAPHICS 0 grid (8-line bands from the
 * first picture row, at the normal or narrow width, without HSCROL).
 *
 * Self-contained by design: it takes a snapshot of the few ANTIC/GTIA
 * registers it needs and a memory reader, never the machine.
 */

import type { OcrResult } from '@/ocr/ocr.ts';

/** What the engine needs to know about the display. */
export interface AtariOcrInput {
  /** The display list's start (ANTIC's counter between frames). */
  readonly dlist: number;
  readonly dmactl: number;
  readonly chbase: number;
  readonly chactl: number;
  /** COLPF0-3 and COLBK, for the overlay's text colours. */
  readonly colpf: ArrayLike<number>;
  readonly colbk: number;
  /** GTIA colour value to an ABGR palette entry. */
  readonly palette: Uint32Array;
  /** Side-effect-free memory read (ANTIC's view). */
  read(addr: number): number;
}

/** One decoded text mode line. */
export interface AtariTextLine {
  /** Buffer row of its first scanline (scanline - 8). */
  readonly y: number;
  readonly mode: number;
  readonly height: number;
  /** Screen codes as fetched. */
  readonly codes: Uint8Array;
  readonly hscroll: boolean;
}

const FIRST_LINE = 8;
const LAST_LINE = 248;
/** Normal-width bytes, scanlines and text flag per ANTIC mode. */
const MODES: readonly ({ bytes: number; lines: number; text: boolean } | null)[] = [
  null, null,
  { bytes: 40, lines: 8, text: true }, { bytes: 40, lines: 10, text: true },
  { bytes: 40, lines: 8, text: true }, { bytes: 40, lines: 16, text: true },
  { bytes: 20, lines: 8, text: true }, { bytes: 20, lines: 16, text: true },
  { bytes: 10, lines: 8, text: false }, { bytes: 10, lines: 4, text: false },
  { bytes: 20, lines: 4, text: false }, { bytes: 20, lines: 2, text: false },
  { bytes: 20, lines: 1, text: false }, { bytes: 40, lines: 2, text: false },
  { bytes: 40, lines: 1, text: false }, { bytes: 40, lines: 1, text: false },
];
const WIDTHS = [0, 256, 320, 384] as const;

/** Walk the display list and decode its text mode lines. */
export function atariTextLines(input: AtariOcrInput): AtariTextLine[] {
  const out: AtariTextLine[] = [];
  if ((input.dmactl & 0x20) === 0) return out;
  const width = input.dmactl & 0x03;
  if (width === 0) return out;
  const read = (a: number) => input.read(a & 0xFFFF) & 0xFF;
  let pc = input.dlist & 0xFFFF;
  const next = () => { pc = (pc & 0xFC00) | ((pc + 1) & 0x03FF); };
  let scan = 0;
  let line = FIRST_LINE;
  for (let guard = 0; guard < 300 && line < LAST_LINE; guard++) {
    const instr = read(pc);
    next();
    const mode = instr & 0x0F;
    if (mode === 0) { line += ((instr >> 4) & 7) + 1; continue; }
    if (mode === 1) break; // JVB: the rest of the frame is blank
    const info = MODES[mode]!;
    if ((instr & 0x40) !== 0) {
      const lo = read(pc); next();
      const hi = read(pc); next();
      scan = lo | (hi << 8);
    }
    const hscroll = (instr & 0x10) !== 0;
    const w = hscroll && width < 3 ? width + 1 : width;
    const bytes = (info.bytes * WIDTHS[w]) / 320;
    const height = (instr & 0x20) !== 0 ? 16 : info.lines;
    if (info.text) {
      const codes = new Uint8Array(bytes);
      for (let i = 0; i < bytes; i++) codes[i] = read((scan & 0xF000) | ((scan + i) & 0x0FFF));
      out.push({ y: line - FIRST_LINE, mode, height, codes, hscroll });
    }
    scan = (scan & 0xF000) | ((scan + bytes) & 0x0FFF);
    line += height;
  }
  return out;
}

/** ANTIC internal code (7 bits) to a display character. */
export function atariInternalChar(code: number): string {
  const c = code & 0x7F;
  if (c < 0x40) return String.fromCharCode(c + 0x20);
  if (c >= 0x61 && c <= 0x7A) return String.fromCharCode(c);
  if (c === 0x7C) return '|';
  if (c === 0x52) return '─'; // ATASCII $12, the horizontal bar
  if (c === 0x40) return '♥'; // ATASCII $00, the heart
  return ' ';
}

/** The internal code a text line's screen byte shows. */
function internalCode(mode: number, byte: number, chbase: number): number {
  if (mode === 6 || mode === 7) return (byte & 0x3F) | ((chbase & 0x02) !== 0 ? 0x40 : 0);
  return byte & 0x7F;
}

/** Where the OS ROM keeps its 128-glyph font. */
const ROM_FONT = 0xE000;

/** Reads screen bytes as characters, glyph-aware (see the header). */
class CharReader {
  private readonly romByGlyph = new Map<string, number>();
  private readonly cache = new Map<string, string>();

  constructor(private readonly input: AtariOcrInput) {
    for (let code = 0; code < 128; code++) {
      const key = this.glyphKey(ROM_FONT + code * 8);
      if (key !== '0,0,0,0,0,0,0,0' && !this.romByGlyph.has(key)) this.romByGlyph.set(key, code);
    }
  }

  private glyphKey(addr: number): string {
    const bytes: number[] = [];
    for (let r = 0; r < 8; r++) bytes.push(this.input.read((addr + r) & 0xFFFF) & 0xFF);
    return bytes.join(',');
  }

  char(mode: number, byte: number): string {
    // Modes 6/7 colour each character from its top two bits. A program that
    // sets that colour register to the background (the usual way to hide
    // the hearts code 0 shows in the lower-case half) leaves it invisible.
    if (mode >= 6 && ((this.input.colpf[(byte >> 6) & 3] ^ this.input.colbk) & 0xFE) === 0) return ' ';
    const chbase = this.input.chbase;
    const base = mode >= 6 ? (chbase & 0xFE) << 8 : (chbase & 0xFC) << 8;
    const index = mode >= 6 ? byte & 0x3F : byte & 0x7F;
    const glyphAt = base + index * 8;
    const code = internalCode(mode, byte, chbase);
    const memo = `${mode}:${glyphAt}:${code}`;
    const hit = this.cache.get(memo);
    if (hit !== undefined) return hit;
    let ch: string;
    if (base === ROM_FONT || base === ROM_FONT + 0x200) {
      ch = atariInternalChar(code);
    } else {
      const key = this.glyphKey(glyphAt);
      const rom = this.romByGlyph.get(key);
      if (key === '0,0,0,0,0,0,0,0') ch = ' ';
      else if (rom !== undefined) ch = atariInternalChar(rom);
      else ch = mode === 4 || mode === 5 ? ' ' : atariInternalChar(code);
    }
    this.cache.set(memo, ch);
    return ch;
  }
}

/** Plain text of every text line, top to bottom, trailing blanks trimmed. */
export function atariOcrText(input: AtariOcrInput): string {
  const reader = new CharReader(input);
  const rows = atariTextLines(input).map(l =>
    Array.from(l.codes, b => reader.char(l.mode, b)).join('').replace(/\s+$/, ''));
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  while (rows.length > 0 && rows[0] === '') rows.shift();
  return rows.join('\n');
}

const COLS = 40;
const ROWS = 24;
/** Buffer row of the standard GRAPHICS 0 screen's first text row. */
const GRID_TOP = 24;

function abgrToHex(abgr: number): string {
  const r = abgr & 0xFF, g = (abgr >>> 8) & 0xFF, b = (abgr >>> 16) & 0xFF;
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
function escapeHtml(ch: string): string {
  return ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
}

/**
 * The 40x24 overlay grid. A text line lands on it when it starts on an
 * 8-line band boundary and is not horizontally scrolled; a 16-pixel mode 6/7
 * character covers two cells (its letter in the first), and a 16-line mode
 * 5/7 row masks both bands it covers. `paper` is left for the machine to
 * sample from the frame, since DLIs may have changed colours mid-screen.
 */
export function atariOcrGrid(input: AtariOcrInput): OcrResult {
  const cells: string[] = new Array(COLS * ROWS).fill(' ');
  const colour: number[] = new Array(COLS * ROWS).fill(-1);
  const mask: boolean[] = new Array(COLS * ROWS).fill(false);
  const width = WIDTHS[input.dmactl & 0x03];
  const leftCol = (320 - width) / 16; // narrow playfield starts 4 cells in
  const reader = new CharReader(input);

  for (const l of atariTextLines(input)) {
    if (l.hscroll || (l.y - GRID_TOP) % 8 !== 0) continue;
    const row = (l.y - GRID_TOP) / 8;
    if (row < 0 || row >= ROWS) continue;
    const wide = l.mode === 6 || l.mode === 7;
    const span = wide ? 2 : 1;
    const bands = l.height >= 16 ? 2 : 1;
    for (let i = 0; i < l.codes.length; i++) {
      const col = leftCol + i * span;
      if (col < 0 || col + span > COLS) continue;
      const byte = l.codes[i];
      const ch = reader.char(l.mode, byte);
      if (ch === ' ') continue;
      const idx = row * COLS + col;
      cells[idx] = ch;
      colour[idx] = wide
        ? input.colpf[(byte >> 6) & 3]
        : l.mode >= 4 ? input.colpf[0]
          : (input.colpf[2] & 0xF0) | (input.colpf[1] & 0x0E);
      for (let b = 0; b < bands; b++) {
        for (let s = 0; s < span; s++) {
          const r = row + b;
          if (r < ROWS) mask[r * COLS + col + s] = true;
        }
      }
    }
  }

  let text = '';
  let html = '';
  for (let row = 0; row < ROWS; row++) {
    let curHex = '';
    let open = false;
    for (let col = 0; col < COLS; col++) {
      const idx = row * COLS + col;
      const ch = cells[idx];
      text += ch;
      if (ch === ' ') {
        if (open) { html += '</span>'; open = false; curHex = ''; }
        html += ' ';
        continue;
      }
      const hex = abgrToHex(input.palette[colour[idx] & 0xFE]);
      if (hex !== curHex) {
        if (open) html += '</span>';
        html += `<span style="color:${hex}">`;
        curHex = hex;
        open = true;
      }
      html += escapeHtml(ch);
    }
    if (open) html += '</span>';
    if (row < ROWS - 1) { text += '\n'; html += '\n'; }
  }
  return { text, html, mask, grid: '40x24', cellWidth: 8, cellHeight: 8, cols: COLS, rows: ROWS };
}
