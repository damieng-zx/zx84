/**
 * The 40-column text screen as text: the same reading of the video matrix as
 * the Commodore 64's (screen codes, power-on or lower-case set, bit 7
 * ignored), through the VIC-IIe's window onto the 128's RAM.
 */

import { c64TextChar } from '@/ocr/c64.ts';
import type { C128Memory } from './memory.ts';

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
