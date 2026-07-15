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
import type { OcrResult } from '@/debug/screen-text.ts';

/** Default ASCII-ordered 8-byte font offset in the MOS ROM (MOS 1.21). The
 *  offset differs by MOS version (1.2 @ 0x106D, 1.21 @ 0x107A), so it is
 *  detected at runtime with {@link findFontOffset}; this is the fallback. */
export const EINSTEIN_FONT_OFFSET = 0x107A;

/**
 * Locate the ASCII-ordered 8-byte-glyph font in the MOS ROM. Scans for the base
 * where the space glyph is blank while letters/digits have a plausible pixel
 * count and punctuation is sparse — robust across MOS versions. Falls back to
 * {@link EINSTEIN_FONT_OFFSET} if nothing scores well.
 */
export function findFontOffset(rom: Uint8Array): number {
  const nz = (base: number, ch: number): number => {
    const a = base + ch * 8;
    if (a + 8 > rom.length) return -1;
    let c = 0;
    for (let i = 0; i < 8; i++) if (rom[a + i]) c++;
    return c;
  };
  let best = EINSTEIN_FONT_OFFSET, bestScore = 0;
  for (let base = 0; base + 0x80 * 8 <= rom.length; base++) {
    if (nz(base, 0x20) !== 0) continue;                 // space must be blank
    let score = 0;
    for (const ch of [0x41, 0x42, 0x43, 0x45, 0x4D, 0x30, 0x31]) { const n = nz(base, ch); if (n >= 3 && n <= 7) score++; }
    for (const ch of [0x2E, 0x2C, 0x3A]) { const n = nz(base, ch); if (n >= 1 && n <= 4) score++; }
    if (score > bestScore) { bestScore = score; best = base; }
  }
  return best;
}

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
 *  ASCII code (or -1 if unrecognised) and whether it matched inverse-video (the
 *  glyph was the font inverted, i.e. the cell's fg/bg are swapped on screen). A
 *  blank glyph matches space. */
function matchGlyph(glyph: Uint8Array, font: Uint8Array): { code: number; inverse: boolean } {
  let blank = true;
  for (let i = 0; i < 8; i++) if (glyph[i] !== 0) { blank = false; break; }
  if (blank) return { code: 0x20, inverse: false };

  let bestCh = -1, bestDiff = 9, bestInv = false; // allow a small tolerance
  for (let ch = FIRST_CH; ch <= LAST_CH; ch++) {
    const fb = ch * 8;
    for (let inv = 0; inv < 2; inv++) {
      let diff = 0;
      for (let p = 0; p < 8 && diff < bestDiff; p++) {
        const f = inv ? (font[fb + p] ^ 0xFF) & 0xFF : font[fb + p] & 0xFF;
        // Compare only the 6 significant bits (cols 0–5): the extractor leaves
        // bits 1–0 blank, but the inverted font sets them, so masking is needed
        // for inverse-video glyphs to match.
        let x = (glyph[p] ^ f) & 0xFC;
        while (x) { diff++; x &= x - 1; } // popcount of differing bits
      }
      if (diff < bestDiff) { bestDiff = diff; bestCh = ch; bestInv = inv === 1; if (diff === 0) return { code: ch, inverse: bestInv }; }
    }
  }
  return bestDiff <= 4 ? { code: bestCh, inverse: bestInv } : { code: -1, inverse: false };
}

/** Foreground/background colour indices (0–15) of the character cell at column
 *  `col`, sampled from the pattern cell holding its left edge. */
function cellColour(vram: Uint8Array, regs: Uint8Array, mode: VdpMode, col: number, row: number): { fg: number; bg: number } {
  const backdrop = regs[7] & 0x0F;
  if (mode === 'text') return { fg: (regs[7] >> 4) & 0x0F, bg: backdrop };
  const nameBase = (regs[2] & 0x0F) << 10;
  const cell = (col * CELL_W) >> 3;
  const name = vram[(nameBase + row * 32 + cell) & 0x3FFF];
  let colByte: number;
  if (mode === 'graphics2') {
    const colBase = (regs[3] & 0x80) << 6;
    const colMask = ((regs[3] & 0x7F) << 3) | 0x07;
    const patternNum = (name + ((row >> 3) << 8)) & colMask;
    colByte = vram[(colBase + (patternNum << 3) + 3) & 0x3FFF];
  } else {
    colByte = vram[((regs[3] << 6) + (name >> 3)) & 0x3FFF];
  }
  let fg = (colByte >> 4) & 0x0F, bg = colByte & 0x0F;
  // Colour 0 is transparent — the TMS9918A shows the backdrop through it, so the
  // effective paper/ink behind a transparent cell is the backdrop colour.
  if (fg === 0) fg = backdrop;
  if (bg === 0) bg = backdrop;
  return { fg, bg };
}

function abgrToHex(abgr: number): string {
  const r = abgr & 0xFF, g = (abgr >>> 8) & 0xFF, b = (abgr >>> 16) & 0xFF;
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
function escapeHtml(ch: string): string {
  return ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
}

export class EinsteinScreenText {
  /** True while the TEXT overlay is showing (gates the per-frame OCR work). */
  active = false;
  activate(): void { this.active = true; }
  deactivate(): void { this.active = false; }

  /** Cached font offset + the ROM it was detected from (re-detect on ROM change). */
  private fontRom: Uint8Array | null = null;
  private fontOff = EINSTEIN_FONT_OFFSET;
  private font(rom: Uint8Array): Uint8Array {
    if (rom !== this.fontRom) { this.fontOff = findFontOffset(rom); this.fontRom = rom; }
    return rom.subarray(this.fontOff);
  }

  /**
   * OCR the current screen to text. `font` is the MOS ROM (8KB) so glyphs can be
   * looked up at EINSTEIN_FONT_OFFSET. Returns rows of text (trailing blank rows
   * and trailing spaces trimmed).
   */
  ocr(vram: Uint8Array, regs: Uint8Array, mode: VdpMode, rom: Uint8Array): string {
    if (mode === 'multicolor') return '(multicolor mode — no text)';
    const font = this.font(rom);
    const cols = Math.floor(256 / CELL_W); // 42 chars across the 256px display
    const rows = 24;
    const glyph = new Uint8Array(8);
    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      let line = '';
      for (let col = 0; col < cols; col++) {
        extractGlyph(vram, regs, mode, col, row, glyph);
        const { code } = matchGlyph(glyph, font);
        line += code >= 0 ? String.fromCharCode(code) : '?';
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  /**
   * Styled OCR for the TEXT overlay: plain text, coloured HTML (per-cell ink
   * colour), and a match mask (matched non-space cells the framebuffer should
   * blank so the crisp overlay glyph replaces the bitmap). `palette` is the
   * TMS9918A ABGR colour table.
   */
  ocrStyled(vram: Uint8Array, regs: Uint8Array, mode: VdpMode, rom: Uint8Array, palette: Uint32Array): OcrResult {
    const cols = Math.floor(256 / CELL_W); // 42
    const rows = 24;
    const font = this.font(rom);
    const glyph = new Uint8Array(8);
    const mask: boolean[] = new Array(cols * rows);
    const paper: number[] = new Array(cols * rows);
    let text = '', html = '', curHex = '', spanOpen = false;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        const { fg, bg } = mode === 'multicolor' ? { fg: 15, bg: 0 } : cellColour(vram, regs, mode, col, row);
        extractGlyph(vram, regs, mode, col, row, glyph);
        const { code, inverse } = mode === 'multicolor' ? { code: -1, inverse: false } : matchGlyph(glyph, font);
        // Inverse video swaps the on-screen fg/bg: the glyph shows in the cell's
        // background colour on a foreground-coloured cell.
        const ink = inverse ? bg : fg;
        const back = inverse ? fg : bg;
        paper[idx] = back;
        const ch = code >= 0 ? String.fromCharCode(code) : ' ';
        text += ch;
        const matched = ch !== ' ';
        mask[idx] = matched;
        if (!matched) {
          if (spanOpen) { html += '</span>'; spanOpen = false; curHex = ''; }
          html += ' ';
          continue;
        }
        const hex = abgrToHex(palette[ink & 0x0F]);
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

    return { text, html, mask, paper, grid: '42x24', cellWidth: CELL_W, cellHeight: 8, cols, rows };
  }
}
