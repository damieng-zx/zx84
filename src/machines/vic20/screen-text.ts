/**
 * The VIC-20's text screen as text.
 *
 * The screen holds screen codes, so it can be read straight out of memory
 * rather than recognised from pixels. The codes are the C64's (the same
 * character ROM layout): the power-on set (VIC $0000, CPU $8000) has
 * capitals at 1-26 and graphics at 65-90, the other set (VIC $0800, CPU
 * $8800) lower case at 1-26 and capitals at 65-90. Bit 7 is reverse video,
 * which the text ignores. Graphics characters come out as spaces only when
 * blank, otherwise as `#`.
 */

import { c64TextChar } from '@/ocr/c64.ts';
import type { Vic20Memory } from './memory.ts';
import type { Vic } from './vic.ts';

/** The text area (columns × rows from the VIC's registers), trailing blanks
 *  and blank lines at the end removed. */
export function vic20ScreenText(mem: Vic20Memory, vic: Vic): string {
  const regs = vic.regs;
  const columns = regs[2] & 0x7F;
  const rows = (regs[3] >> 1) & 0x3F;
  const screen = vic.screenAddress;
  const lower = (vic.charAddress & 0x0C00) === 0x0800;
  const out: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let col = 0; col < columns; col++) {
      const code = mem.vicRead((screen + row * columns + col) & 0x3FFF);
      line += c64TextChar(code, lower) ?? '#';
    }
    out.push(line.replace(/\s+$/, ''));
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
