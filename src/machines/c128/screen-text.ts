/**
 * The 40-column text screen as text: the same reading of the video matrix as
 * the Commodore 64's (screen codes, power-on or lower-case set, bit 7
 * ignored), through the VIC-IIe's window onto the 128's RAM.
 */

import { c64TextChar, cbmMatchGlyph, cbmRomGlyphs } from '@/ocr/c64.ts';
import type { C128Memory } from './memory.ts';
import { VDC_R, type Vdc } from './vdc.ts';

/**
 * The VDC's text screen as text: the cells at the display start address, the
 * editor's screen codes read as on the 64 (the cell's alternate-set attribute
 * stands for the lower-case set), trailing blanks and blank lines removed.
 * With the character ROM's glyphs as `reference` a cell is read by the shape it
 * shows instead, so a font in another order (CP/M's, whose lower case sits at
 * the ASCII codes) reads right; a glyph that matches nothing falls back to its code.
 */
export function vdcScreenText(vdc: Vdc, reference: Uint8Array | null = null): string {
  const r = vdc.regs;
  if ((r[VDC_R.MODE] & 0x80) !== 0) return '[c128] the 80-column screen is in a bitmap mode: no text to read';
  const cols = r[VDC_R.HDISP];
  const rowsN = r[VDC_R.VDISP];
  const screen = (r[VDC_R.SCREEN_HI] << 8) | r[VDC_R.SCREEN_LO];
  const attrs = (r[VDC_R.ATTR_HI] << 8) | r[VDC_R.ATTR_LO];
  const stride = cols + r[VDC_R.ROW_ADD];
  const colour = (r[VDC_R.MODE] & 0x40) !== 0;
  const charBase = (r[VDC_R.CHARSET] & 0xE0) << 8;
  const shapes = reference ? cbmRomGlyphs(reference) : null;
  const seen = new Map<number, { ch: string; reversed: boolean }>();
  const rows: string[] = [];
  for (let row = 0; row < rowsN; row++) {
    let line = '';
    for (let col = 0; col < cols; col++) {
      const cell = row * stride + col;
      const attr = colour ? vdc.at(attrs + cell) : 0;
      const lower = (attr & 0x80) !== 0;
      const code = vdc.at(screen + cell);
      if (shapes) {
        const m = cbmMatchGlyph(shapes, a => vdc.at(a), (charBase + (lower ? 0x1000 : 0) + code * 16) & 0xFFFF, seen);
        if (m.ch !== ' ') { line += m.ch; continue; }
      }
      line += c64TextChar(code, lower) ?? '#';
    }
    rows.push(line.replace(/\s+$/, ''));
  }
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}

/** The 40×25 text screen, trailing blanks and blank lines at the end removed.
 *  A bitmap mode says so instead. */
export function c128ScreenText(mem: C128Memory, regs: Uint8Array): string {
  if ((regs[0x11] & 0x20) !== 0) return '[c128] the screen is in a bitmap mode: no text to read';
  const screen = (regs[0x18] & 0xF0) << 6;
  const lower = (regs[0x18] & 0x02) !== 0;
  const ecm = (regs[0x11] & 0x40) !== 0;
  const rows: string[] = [];
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 40; col++) {
      let code = mem.vicRead(screen + row * 40 + col);
      if (ecm) code &= 0x3F;
      line += c64TextChar(code, lower) ?? '#';
    }
    rows.push(line.replace(/\s+$/, ''));
  }
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}
