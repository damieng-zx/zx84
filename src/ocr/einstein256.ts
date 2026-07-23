/**
 * Einstein 256 (V9938) screen-text OCR.
 *
 * The Einstein 256's MOS 2.1 draws its console with the V9938 in GRAPHIC 2
 * (MSX SCREEN 2) using an *identity* name table — exactly the TC-01's trick, so
 * "text" is really a 1-bpp bitmap in the pattern generator. We reconstruct each
 * pixel with the V9938's own GRAPHIC 2 addressing (mirroring
 * `V9938.renderGraphic23`: three vertical thirds, `patBase=(R4&0x3C)<<11`,
 * `colBase=(R3&0x80)<<6`), extract each 6-px MOS glyph and match it against the
 * MOS ROM font — sharing {@link matchGlyph} / {@link findFontOffset} with the
 * TC-01 engine, which reads the same font.
 *
 * Only GRAPHIC 2 is handled (the mode MOS 2.1 boots into); other V9938 modes
 * report no text. Consumed by the MCP `ocr` tool via
 * `EinsteinMachine.ocrScreenForMcp` and by the TEXT overlay via `ocrStyled`.
 */

import type { V9938Mode } from '@/cores/v9938.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import { EINSTEIN_CELL_W, findFontOffset, matchGlyph } from '@/ocr/einstein.ts';

const CELL_W = EINSTEIN_CELL_W;   // 6-px MOS font pitch
const COLS = Math.floor(256 / CELL_W); // 42 chars across the 256-px GRAPHIC 2 field
const ROWS = 24;                  // 192 active lines / 8

/** GRAPHIC 2 table geometry decoded from the VDP registers (see
 *  `V9938.renderGraphic23`). */
interface G2Tables {
  nameBase: number;
  patBase: number;
  patMask: number;
  colBase: number;
  colMask: number;
}

function g2Tables(regs: Uint8Array): G2Tables {
  return {
    nameBase: regs[2] << 10,
    patBase: (regs[4] & 0x3C) << 11,
    patMask: ((regs[4] & 0x03) << 8) | 0xFF,
    colBase: (regs[3] & 0x80) << 6,
    colMask: ((regs[3] & 0x7F) << 3) | 7,
  };
}

/** The GRAPHIC 2 pattern-generator code for character cell (col,row): the
 *  identity name-table entry offset into its vertical third. */
function cellCode(vram: Uint8Array, t: G2Tables, cell: number, row: number): number {
  const third = (row & 0x18) << 5;   // rows 0-7/8-15/16-23 → 0/0x100/0x200
  return vram[(t.nameBase + row * 32 + cell) % vram.length] + third;
}

/** Value (0/1) of the GRAPHIC 2 display pixel at (x, row, line). */
function pixel(vram: Uint8Array, t: G2Tables, x: number, row: number, line: number): number {
  const code = cellCode(vram, t, x >> 3, row);
  const bits = vram[(t.patBase + ((code & t.patMask) << 3) + line) % vram.length];
  return (bits >> (7 - (x & 7))) & 1;
}

/** Extract one 6-px glyph at column `col` (6-px pitch), packing the 6 pixels
 *  left-aligned into bits 7–2 to line up with the font bytes. */
function extractGlyph(vram: Uint8Array, t: G2Tables, col: number, row: number, out: Uint8Array): void {
  const x0 = col * CELL_W;
  for (let line = 0; line < 8; line++) {
    let b = 0;
    for (let px = 0; px < CELL_W; px++) b |= pixel(vram, t, x0 + px, row, line) << (7 - px);
    out[line] = b;
  }
}

/** Foreground/background colour indices (0–15) of the character cell at column
 *  `col`, sampled from the GRAPHIC 2 colour table at the cell's left edge. */
function cellColour(vram: Uint8Array, regs: Uint8Array, t: G2Tables, col: number, row: number): { fg: number; bg: number } {
  const cell = (col * CELL_W) >> 3;
  const code = cellCode(vram, t, cell, row);
  const colByte = vram[(t.colBase + ((code & t.colMask) << 3) + 3) % vram.length];
  const backdrop = regs[7] & 0x0F;
  let fg = (colByte >> 4) & 0x0F, bg = colByte & 0x0F;
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

export class EinsteinV9938ScreenText {
  /** True while the TEXT overlay is showing (gates the per-frame OCR work). */
  active = false;
  activate(): void { this.active = true; }
  deactivate(): void { this.active = false; }

  /** Cached font offset + the ROM it was detected from (re-detect on ROM change). */
  private fontRom: Uint8Array | null = null;
  private fontOff = 0;
  private font(rom: Uint8Array): Uint8Array {
    if (rom !== this.fontRom) { this.fontOff = findFontOffset(rom); this.fontRom = rom; }
    return rom.subarray(this.fontOff);
  }

  /** OCR the current screen to plain text (trailing spaces / blank rows trimmed).
   *  Only GRAPHIC 2 is textual; other modes report no text. */
  ocr(vram: Uint8Array, regs: Uint8Array, mode: V9938Mode, rom: Uint8Array): string {
    if (mode !== 'graphic2') return `(${mode} mode — no text)`;
    const t = g2Tables(regs);
    const font = this.font(rom);
    const glyph = new Uint8Array(8);
    const lines: string[] = [];
    for (let row = 0; row < ROWS; row++) {
      let line = '';
      for (let col = 0; col < COLS; col++) {
        extractGlyph(vram, t, col, row, glyph);
        const { code } = matchGlyph(glyph, font);
        line += code >= 0 ? String.fromCharCode(code) : '?';
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  /** Styled OCR for the TEXT overlay: plain text, per-cell coloured HTML, and a
   *  match mask + paper indices so the framebuffer cells can be blanked.
   *  `pens` is the V9938 ABGR colour table. */
  ocrStyled(vram: Uint8Array, regs: Uint8Array, mode: V9938Mode, rom: Uint8Array, pens: Uint32Array): OcrResult {
    if (mode !== 'graphic2') {
      return { text: '', html: '', mask: [], paper: [], grid: '42x24', cellWidth: CELL_W, cellHeight: 8, cols: 0, rows: 0 };
    }
    const t = g2Tables(regs);
    const font = this.font(rom);
    const glyph = new Uint8Array(8);
    const mask: boolean[] = new Array(COLS * ROWS);
    const paper: number[] = new Array(COLS * ROWS);
    let text = '', html = '', curHex = '', spanOpen = false;

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const idx = row * COLS + col;
        const { fg, bg } = cellColour(vram, regs, t, col, row);
        extractGlyph(vram, t, col, row, glyph);
        const { code, inverse } = matchGlyph(glyph, font);
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
        const hex = abgrToHex(pens[ink & 0x0F]);
        if (hex !== curHex) {
          if (spanOpen) html += '</span>';
          html += `<span style="color:${hex}">`;
          curHex = hex;
          spanOpen = true;
        }
        html += escapeHtml(ch);
      }
      if (spanOpen) { html += '</span>'; spanOpen = false; curHex = ''; }
      if (row < ROWS - 1) { text += '\n'; html += '\n'; }
    }

    return { text, html, mask, paper, grid: '42x24', cellWidth: CELL_W, cellHeight: 8, cols: COLS, rows: ROWS };
  }
}
