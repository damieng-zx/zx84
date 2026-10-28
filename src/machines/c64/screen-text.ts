/**
 * The C64's text screen as text.
 *
 * In the text modes the video matrix holds screen codes, so the screen can be
 * read straight out of it rather than recognised from pixels. Screen codes
 * 0-63 are the same in both character sets apart from the letters: the
 * power-on set has capitals at 1-26 and graphics at 65-90, the other set
 * ($D018 bit 1) lower case at 1-26 and capitals at 65-90. Bit 7 is reverse
 * video, which the text ignores. Graphics characters come out as spaces only
 * when blank; otherwise as `#`, so a picture made of them is not mistaken
 * for text.
 */

import type { C64Memory } from './memory.ts';

const PUNCT = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[£]^_ !"#$%&\'()*+,-./0123456789:;<=>?';

function screenChar(code: number, lower: boolean): string {
  const c = code & 0x7F;
  if (c < 64) {
    if (lower && c >= 1 && c <= 26) return String.fromCharCode(0x60 + c);
    return PUNCT[c];
  }
  if (lower && c >= 65 && c <= 90) return String.fromCharCode(c);
  if (c === 96) return ' ';   // shifted space
  return '#';
}

/** The 40×25 text screen, trailing blanks and blank lines at the end removed.
 *  A bitmap mode says so instead. */
export function c64ScreenText(mem: C64Memory, regs: Uint8Array): string {
  if ((regs[0x11] & 0x20) !== 0) return '[c64] the screen is in a bitmap mode: no text to read';
  const screen = mem.vicBase | ((regs[0x18] & 0xF0) << 6);
  const lower = (regs[0x18] & 0x02) !== 0;
  const ecm = (regs[0x11] & 0x40) !== 0;
  const rows: string[] = [];
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 40; col++) {
      let code = mem.ram[(screen + row * 40 + col) & 0xFFFF];
      if (ecm) code &= 0x3F;
      line += screenChar(code, lower);
    }
    rows.push(line.replace(/\s+$/, ''));
  }
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}
