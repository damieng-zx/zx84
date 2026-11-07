/**
 * Commodore 64 screen-text OCR.
 *
 * Like the MSX and Atari, the 64 keeps character *codes* in screen memory, so
 * text is read from the video matrix rather than recognised from pixels. The
 * glyph each code shows is looked at too, since programs often bring their own
 * character set: a blank glyph reads as a space; a glyph identical to a
 * character of the ROM font (either set, wherever the program put it) reads as
 * that character; the inverse of one reads as that character in reverse video.
 * Anything else (graphics, a tile set) is not text and is left alone.
 *
 * Only the character modes are read: standard text, extended-colour text and
 * hires cells of multicolour text. A bitmap mode has no text, and a
 * multicolour cell (colour RAM bit 3 set in multicolour text) is a picture.
 *
 * Self-contained by design: it takes the VIC-II registers, the character ROM
 * and two readers, never the machine.
 */

import type { OcrResult } from '@/ocr/ocr.ts';

/** What the engine needs to know about the display. */
export interface C64OcrInput {
  /** The VIC-II registers ($D000-$D03F). */
  readonly regs: Uint8Array;
  /** The 4K character ROM, set 1 (capitals and graphics) then set 2 (lower case). */
  readonly chargen: Uint8Array;
  /** Colour index to an ABGR palette entry. */
  readonly palette: Uint32Array;
  /** A byte of the VIC-II's 16K view of memory. */
  vicRead(addr14: number): number;
  /** A cell's colour RAM nibble (0-999). */
  colour(index: number): number;
}

/** The overlay grid, with the colour each matched cell's blanking should use. */
export type C64OcrResult = OcrResult & { paper: number[] };

const COLS = 40;
const ROWS = 25;

const PUNCT = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[£]^_ !"#$%&\'()*+,-./0123456789:;<=>?';

/**
 * The character a screen code shows in the ROM font, or null for graphics.
 * Codes 0-63 are the same in both sets apart from the letters: the power-on
 * set has capitals at 1-26 and graphics at 65-90, the other set ($D018 bit 1)
 * lower case at 1-26 and capitals at 65-90. Bit 7 is reverse video.
 */
export function c64TextChar(code: number, lower: boolean): string | null {
  const c = code & 0x7F;
  if (c < 64) {
    if (lower && c >= 1 && c <= 26) return String.fromCharCode(0x60 + c);
    return PUNCT[c];
  }
  if (lower && c >= 65 && c <= 90) return String.fromCharCode(c);
  if (c === 96) return ' ';   // shifted space
  return null;
}

/** A glyph as a string of its eight row bytes, usable as a map key. */
function glyphKey(read: (row: number) => number): string {
  let key = '';
  for (let row = 0; row < 8; row++) key += String.fromCharCode(read(row) & 0xFF);
  return key;
}

function invertKey(key: string): string {
  let out = '';
  for (let i = 0; i < key.length; i++) out += String.fromCharCode(~key.charCodeAt(i) & 0xFF);
  return out;
}

const romGlyphCache = new WeakMap<Uint8Array, Map<string, string>>();

/** Every text glyph of the ROM font (both sets), keyed by its bytes. */
function romGlyphs(chargen: Uint8Array): Map<string, string> {
  const cached = romGlyphCache.get(chargen);
  if (cached) return cached;
  const map = new Map<string, string>();
  for (let set = 0; set < 2; set++) {
    for (let code = 0; code < 128; code++) {
      const ch = c64TextChar(code, set === 1);
      const at = set * 0x800 + code * 8;
      if (ch === null || ch === ' ' || at + 8 > chargen.length) continue;
      const key = glyphKey(row => chargen[at + row]);
      if (!map.has(key)) map.set(key, ch);
    }
  }
  romGlyphCache.set(chargen, map);
  return map;
}

function abgrToHex(abgr: number): string {
  const r = abgr & 0xFF, g = (abgr >>> 8) & 0xFF, b = (abgr >>> 16) & 0xFF;
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function escapeHtml(ch: string): string {
  return ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
}

/**
 * The 40x25 overlay grid. A matched cell is drawn in its colour RAM colour on
 * the background; one in reverse video swaps the two, and `paper` is the
 * colour the cell's pixels are blanked to (what the overlay's background
 * should match).
 */
export function c64OcrGrid(input: C64OcrInput): C64OcrResult {
  const { regs } = input;
  const cells: string[] = new Array(COLS * ROWS).fill(' ');
  const ink: number[] = new Array(COLS * ROWS).fill(0);
  const paper: number[] = new Array(COLS * ROWS).fill(regs[0x21] & 0x0F);
  const mask: boolean[] = new Array(COLS * ROWS).fill(false);

  if ((regs[0x11] & 0x20) === 0) {
    const screen = (regs[0x18] & 0xF0) << 6;
    const charBase = (regs[0x18] & 0x0E) << 10;
    const ecm = (regs[0x11] & 0x40) !== 0;
    const mcm = (regs[0x16] & 0x10) !== 0;
    const rom = romGlyphs(input.chargen);
    const seen = new Map<number, { ch: string; reversed: boolean }>();

    const read = (addr: number): { ch: string; reversed: boolean } => {
      const hit = seen.get(addr);
      if (hit) return hit;
      let blank = true, solid = true;
      const key = glyphKey(row => {
        const b = input.vicRead(addr + row) & 0xFF;
        if (b !== 0) blank = false;
        if (b !== 0xFF) solid = false;
        return b;
      });
      let found: { ch: string; reversed: boolean } = { ch: ' ', reversed: false };
      if (!blank && !solid) {
        const direct = rom.get(key);
        if (direct !== undefined) found = { ch: direct, reversed: false };
        else {
          const inverse = rom.get(invertKey(key));
          if (inverse !== undefined) found = { ch: inverse, reversed: true };
        }
      }
      seen.set(addr, found);
      return found;
    };

    for (let i = 0; i < COLS * ROWS; i++) {
      const raw = input.vicRead(screen + i) & 0xFF;
      const colour = input.colour(i) & 0x0F;
      if (mcm && (colour & 8) !== 0) continue;
      const { ch, reversed } = read(charBase | ((ecm ? raw & 0x3F : raw) << 3));
      if (ch === ' ') continue;
      const background = ecm ? regs[0x21 + (raw >> 6)] & 0x0F : regs[0x21] & 0x0F;
      const foreground = mcm ? colour & 7 : colour;
      cells[i] = ch;
      mask[i] = true;
      ink[i] = reversed ? background : foreground;
      paper[i] = reversed ? foreground : background;
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
      const hex = abgrToHex(input.palette[ink[idx] & 0x0F]);
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
  return { text, html, mask, paper, grid: '40x25', cellWidth: 8, cellHeight: 8, cols: COLS, rows: ROWS };
}
