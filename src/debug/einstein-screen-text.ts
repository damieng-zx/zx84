/**
 * Einstein screen-text OCR.
 *
 * The Einstein draws text as a character/bitmap grid on the TMS9929A (usually
 * Graphics II with an identity name table, so "text" is really an 8×8 pixel
 * bitmap). To recover the text we extract each cell's 8×8 glyph straight from
 * VRAM using the current mode's addressing, then match it against the MOS ROM
 * font (ASCII-ordered 8-byte glyphs at {@link EINSTEIN_FONT_OFFSET}). MOS and
 * Xtal DOS both render with this font, so a match yields the ASCII code.
 *
 * Consumed by the MCP `ocr` tool via `EinsteinMachine.ocrScreenForMcp`.
 */

import type { VdpMode } from '@/cores/tms9918a.ts';

/** ASCII-ordered 8-byte font glyphs in the 8KB MOS ROM (glyph C at +C*8). */
export const EINSTEIN_FONT_OFFSET = 0x107A;

const FIRST_CH = 0x20;   // space
const LAST_CH = 0x7E;    // ~

/** Character cell width in pixels. The Einstein system font (MOS + Xtal DOS) is
 *  6 pixels wide, drawn at a 6-pixel pitch, so glyphs straddle the VDP's 8-pixel
 *  pattern cells — the OCR reconstructs pixels and reads them at this pitch. */
const CELL_W = 6;

/** Value of the display pixel at (x, charRow, line), 0 or 1, for the current
 *  mode. In Graphics II the name table indexes the bitmap; in Graphics I / Text
 *  it indexes the pattern generator. */
function pixel(vram: Uint8Array, regs: Uint8Array, mode: VdpMode,
               x: number, charRow: number, line: number): number {
  const nameBase = (regs[2] & 0x0F) << 10;
  const cell = x >> 3;
  const bit = 7 - (x & 7);
  let byte: number;
  if (mode === 'graphics2') {
    const name = vram[(nameBase + charRow * 32 + cell) & 0x3FFF];
    const patBase = (regs[4] & 0x04) << 11;
    const patMask = ((regs[4] & 0x03) << 8) | 0xFF;
    const patternNum = (name + ((charRow >> 3) << 8)) & patMask;
    byte = vram[(patBase + (patternNum << 3) + line) & 0x3FFF];
  } else {
    const name = vram[(nameBase + charRow * 32 + cell) & 0x3FFF];
    const patBase = (regs[4] & 0x07) << 11;
    byte = vram[(patBase + name * 8 + line) & 0x3FFF];
  }
  return (byte >> bit) & 1;
}

/** Extract one glyph at character column `col` (6-pixel pitch), packing the 6
 *  pixels left-aligned into bits 7–2 so it lines up bit-for-bit with the font
 *  bytes (whose glyphs occupy the top 6 bits, bits 1–0 blank). */
function extractGlyph(vram: Uint8Array, regs: Uint8Array, mode: VdpMode,
                      col: number, row: number, out: Uint8Array): void {
  const x0 = col * CELL_W;
  for (let line = 0; line < 8; line++) {
    let b = 0;
    for (let px = 0; px < CELL_W; px++) b |= pixel(vram, regs, mode, x0 + px, row, line) << (7 - px);
    out[line] = b;
  }
}

/** Match an 8-byte glyph against the font (normal + inverse video). Returns the
 *  ASCII code, or -1 if unrecognised. A blank glyph matches space. */
function matchGlyph(glyph: Uint8Array, font: Uint8Array): number {
  let blank = true;
  for (let i = 0; i < 8; i++) if (glyph[i] !== 0) { blank = false; break; }
  if (blank) return 0x20;

  let bestCh = -1, bestDiff = 9; // allow a small tolerance for near-matches
  for (let ch = FIRST_CH; ch <= LAST_CH; ch++) {
    const fb = ch * 8;
    for (let inv = 0; inv < 2; inv++) {
      let diff = 0;
      for (let p = 0; p < 8 && diff < bestDiff; p++) {
        const f = inv ? (font[fb + p] ^ 0xFF) & 0xFF : font[fb + p] & 0xFF;
        let x = (glyph[p] ^ f) & 0xFF;
        while (x) { diff++; x &= x - 1; } // popcount of differing bits
      }
      if (diff < bestDiff) { bestDiff = diff; bestCh = ch; if (diff === 0) return ch; }
    }
  }
  return bestDiff <= 4 ? bestCh : -1;
}

export class EinsteinScreenText {
  /**
   * OCR the current screen to text. `font` is the MOS ROM (8KB) so glyphs can be
   * looked up at EINSTEIN_FONT_OFFSET. Returns rows of text (trailing blank rows
   * and trailing spaces trimmed).
   */
  ocr(vram: Uint8Array, regs: Uint8Array, mode: VdpMode, rom: Uint8Array): string {
    if (mode === 'multicolor') return '(multicolor mode — no text)';
    const font = rom.subarray(EINSTEIN_FONT_OFFSET);
    const cols = Math.floor(256 / CELL_W); // 42 chars across the 256px display
    const rows = 24;
    const glyph = new Uint8Array(8);
    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      let line = '';
      for (let col = 0; col < cols; col++) {
        extractGlyph(vram, regs, mode, col, row, glyph);
        const ch = matchGlyph(glyph, font);
        line += ch >= 0 ? String.fromCharCode(ch) : '?';
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }
}
