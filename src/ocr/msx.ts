/**
 * MSX screen-text OCR.
 *
 * Unlike the Spectrum/CPC/Einstein engines — which reconstruct pixels and match
 * them against a font — the MSX VDP is far simpler to read: in the text modes
 * (SCREEN 0 = TMS text, SCREEN 1 = Graphics I) the *name table* holds the
 * character codes directly (the pattern generator holds the glyphs), and the MSX
 * character set is ASCII for 0x20–0x7E. So OCR is a direct name-table read — no
 * font matching, exact for standard text (a program that redefines the pattern
 * table still reports the standard glyph for each code, as the other engines do).
 *
 * Consumed by the MCP `ocr` tool via `MsxMachine.ocrScreenForMcp` and by the
 * TEXT overlay via `ocrStyled`.
 */

import type { VdpMode } from '@/cores/tms9918a.ts';
import type { OcrResult, OcrGridName } from '@/ocr/ocr.ts';

/** Per-mode text-grid geometry, matching the TMS9918A renderer in
 *  `cores/tms9918a.ts` (text: 40 cols of 6px from x=8; graphics1: 32 cols of
 *  8px from x=0). */
export interface MsxTextGrid {
  cols: number;
  cellWidth: number;
  xOffset: number;
  grid: OcrGridName;
}

/** Resolve the text grid for a VDP mode, or null if the mode isn't textual. */
export function msxTextGrid(mode: VdpMode): MsxTextGrid | null {
  if (mode === 'text') return { cols: 40, cellWidth: 6, xOffset: 8, grid: '40x24' };
  if (mode === 'graphics1') return { cols: 32, cellWidth: 8, xOffset: 0, grid: '32x24' };
  return null; // graphics2 / multicolor are bitmap modes — no text layer
}

const ROWS = 24;

/** MSX character code → display character. ASCII printables pass through; other
 *  codes (control, graphics, international) render as a space for OCR purposes. */
function msxChar(code: number): string {
  return code >= 0x20 && code <= 0x7E ? String.fromCharCode(code) : ' ';
}

function abgrToHex(abgr: number): string {
  const r = abgr & 0xFF, g = (abgr >>> 8) & 0xFF, b = (abgr >>> 16) & 0xFF;
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
function escapeHtml(ch: string): string {
  return ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
}

/** Foreground/background colour indices (0–15) of the cell at (col,row). Text
 *  mode uses R7 globally; Graphics I uses the colour table (8-char groups).
 *  Colour 0 is transparent → resolves to the backdrop. */
function cellColour(vram: Uint8Array, regs: Uint8Array, mode: VdpMode, name: number): { fg: number; bg: number } {
  const backdrop = regs[7] & 0x0F;
  let fg: number, bg: number;
  if (mode === 'text') {
    fg = (regs[7] >> 4) & 0x0F;
    bg = backdrop;
  } else {
    const colBase = regs[3] << 6;
    const colByte = vram[(colBase + (name >> 3)) & 0x3FFF];
    fg = (colByte >> 4) & 0x0F;
    bg = colByte & 0x0F;
  }
  if (fg === 0) fg = backdrop;
  if (bg === 0) bg = backdrop;
  return { fg, bg };
}

export class MsxScreenText {
  /** True while the TEXT overlay is showing (gates the per-frame OCR work). */
  active = false;
  activate(): void { this.active = true; }
  deactivate(): void { this.active = false; }

  private nameBase(regs: Uint8Array): number { return (regs[2] & 0x0F) << 10; }

  /** OCR the current screen to plain text (trailing spaces / blank rows trimmed). */
  ocr(vram: Uint8Array, regs: Uint8Array, mode: VdpMode): string {
    const g = msxTextGrid(mode);
    if (!g) return '(graphics mode — no text)';
    const base = this.nameBase(regs);
    const lines: string[] = [];
    for (let row = 0; row < ROWS; row++) {
      let line = '';
      for (let col = 0; col < g.cols; col++) {
        line += msxChar(vram[(base + row * g.cols + col) & 0x3FFF]);
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  /** Styled OCR for the TEXT overlay: plain text, per-cell coloured HTML, and a
   *  match mask + paper indices so the framebuffer cells can be blanked. */
  ocrStyled(vram: Uint8Array, regs: Uint8Array, mode: VdpMode, palette: Uint32Array): OcrResult {
    const g = msxTextGrid(mode);
    if (!g) {
      return { text: '', html: '', mask: [], paper: [], grid: '32x24', cellWidth: 8, cellHeight: 8, cols: 32, rows: ROWS };
    }
    const base = this.nameBase(regs);
    const mask: boolean[] = new Array(g.cols * ROWS);
    const paper: number[] = new Array(g.cols * ROWS);
    let text = '', html = '', curHex = '', spanOpen = false;

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < g.cols; col++) {
        const idx = row * g.cols + col;
        const name = vram[(base + row * g.cols + col) & 0x3FFF];
        const { fg, bg } = cellColour(vram, regs, mode, name);
        paper[idx] = bg;
        const ch = msxChar(name);
        text += ch;
        const matched = ch !== ' ';
        mask[idx] = matched;
        if (!matched) {
          if (spanOpen) { html += '</span>'; spanOpen = false; curHex = ''; }
          html += ' ';
          continue;
        }
        const hex = abgrToHex(palette[fg & 0x0F]);
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

    return { text, html, mask, paper, grid: g.grid, cellWidth: g.cellWidth, cellHeight: 8, cols: g.cols, rows: ROWS };
  }
}
