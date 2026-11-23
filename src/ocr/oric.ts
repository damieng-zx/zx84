/**
 * Oric text-screen OCR.
 *
 * The Oric's text screen is the simplest possible: 40x28 bytes at $BB80, each
 * an ASCII code, drawn with the 6x8 character set the ROM copies into RAM at
 * $B400. So the text is read straight out of memory — the same bytes the ULA
 * fetches — and only the styling (ink, paper, inverse, blink, the cell's own
 * attribute) needs decoding from the serial attributes on the line.
 *
 * Hires screens have no text to recover, so the result is empty when the mode
 * register says hires and no text tail has been written.
 */

import type { OcrResult } from '@/ocr/ocr.ts';
import {
  ORIC_CELL_HEIGHT, ORIC_CELL_WIDTH, ORIC_TEXT_COLS,
  ORIC_TEXT_ROWS, ORIC_TEXT_SCREEN,
} from '@/machines/oric/constants.ts';

/** Style-register bits, as `oric-ula.ts` decodes them. */
const STYLE_ALT_CHARSET = 0x01;
const STYLE_DOUBLE_HEIGHT = 0x02;
const STYLE_BLINK = 0x04;

/** A printable byte's character, or null for an attribute or unmapped code. */
export function oricCodeToAscii(code: number): string | null {
  const c = code & 0x7F;
  if (c < 0x20 || c > 0x7F) return null;
  return String.fromCharCode(c);
}

/** A cell's inverse-video flag. */
export function oricCodeIsInverse(code: number): boolean {
  return (code & 0x80) !== 0;
}

/** The palette index a byte draws with, decoded from the line's attributes. */
interface LineState {
  ink: number;
  paper: number;
  style: number;
}

/**
 * Walk one 40-byte line, returning the printable cells and the colours each
 * one was drawn in. Attributes take a cell of their own and update the state
 * for the rest of the line, exactly as the ULA does.
 */
function scanLine(ram: Uint8Array, base: number): { text: string; cells: { ink: number; paper: number; inverse: boolean }[] } {
  const state: LineState = { ink: 7, paper: 0, style: 0 };
  let text = '';
  const cells: { ink: number; paper: number; inverse: boolean }[] = [];
  for (let col = 0; col < ORIC_TEXT_COLS; col++) {
    const ch = ram[(base + col) & 0xFFFF];
    if ((ch & 0x60) === 0) {
      switch (ch & 0x18) {
        case 0x00: state.ink = ch & 7; break;
        case 0x08: state.style = ch & 7; break;
        case 0x10: state.paper = ch & 7; break;
        default: break;
      }
      text += ' ';
      cells.push({ ink: state.paper, paper: state.paper, inverse: false });
      continue;
    }
    const ascii = oricCodeToAscii(ch);
    const inverse = oricCodeIsInverse(ch);
    text += ascii ?? ' ';
    cells.push({
      ink: inverse ? state.paper : state.ink,
      paper: inverse ? state.ink : state.paper,
      inverse,
    });
  }
  return { text, cells };
}

/** The eight ULA colours as CSS hex, for the HTML overlay. */
export const ORIC_CSS_COLOURS = [
  '#000000', '#ff0000', '#00ff00', '#ffff00',
  '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
] as const;

/** Read the whole text screen, trailing blank lines trimmed. */
export function ocrOricText(ram: Uint8Array): OcrResult {
  const lines: string[] = [];
  const html: string[] = [];
  const mask: boolean[] = [];
  const paper: number[] = [];

  for (let row = 0; row < ORIC_TEXT_ROWS; row++) {
    const base = ORIC_TEXT_SCREEN + row * ORIC_TEXT_COLS;
    const { text, cells } = scanLine(ram, base);
    const trimmed = text.replace(/\s+$/, '');
    lines.push(trimmed);
    mask.push(...cells.map(c => c.paper !== 0 || c.inverse));
    paper.push(...cells.map(c => c.paper));

    let rowHtml = '';
    for (let col = 0; col < cells.length; col++) {
      const c = cells[col];
      const ch = text[col] ?? ' ';
      if (ch === ' ' && c.paper === 0) { rowHtml += '&nbsp;'; continue; }
      const style = `color:${ORIC_CSS_COLOURS[c.ink & 7]};background:${ORIC_CSS_COLOURS[c.paper & 7]}`;
      rowHtml += `<span style="${style}">${ch === ' ' ? '&nbsp;' : escapeHtml(ch)}</span>`;
    }
    html.push(rowHtml);
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return {
    text: lines.join('\n'),
    html: html.join('<br>'),
    mask,
    paper,
    grid: '40x28',
    cellWidth: ORIC_CELL_WIDTH,
    cellHeight: ORIC_CELL_HEIGHT,
    cols: ORIC_TEXT_COLS,
    rows: ORIC_TEXT_ROWS,
  };
}

/** The active display area, for a transcribe overlay stretched over it. */
export const ORIC_TEXT_FIELD = {
  x: 0, y: 0, width: ORIC_TEXT_COLS * ORIC_CELL_WIDTH, height: ORIC_TEXT_ROWS * ORIC_CELL_HEIGHT,
};

function escapeHtml(ch: string): string {
  switch (ch) {
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '&': return '&amp;';
    case '"': return '&quot;';
    default: return ch;
  }
}

/** True when the line's style has anything the OCR should report. */
export function oricStyleFlags(style: number): { altCharset: boolean; doubleHeight: boolean; blink: boolean } {
  return {
    altCharset: (style & STYLE_ALT_CHARSET) !== 0,
    doubleHeight: (style & STYLE_DOUBLE_HEIGHT) !== 0,
    blink: (style & STYLE_BLINK) !== 0,
  };
}
