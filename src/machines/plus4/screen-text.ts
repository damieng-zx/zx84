/**
 * The Plus/4's text screen as text.
 *
 * The screen holds screen codes, so it can be read straight out of memory. The
 * codes are PETSCII's (the C64's layout: capitals at 1-26 in the power-on set,
 * lower case at 1-26 in the other), which is why the shared C64 helpers serve:
 * `$FF13` bit 0 selects the set the TED fetches through.
 *
 * Only the character modes have text: the two bitmap modes have none. A
 * multicolour cell is a picture and reads as `#`, as an unmatched glyph does.
 */

import { c64TextChar } from '@/ocr/c64.ts';
import type { Plus4Memory } from './memory.ts';
import type { Ted } from './ted.ts';

/** The text area (40 × 25 from the TED's registers), trailing blanks and blank
 *  lines at the end removed. */
export function plus4ScreenText(mem: Plus4Memory, ted: Ted): string {
  if (ted.bitmapMode || ted.illegalMode) return '';
  const screen = ted.screenAddress;
  const lower = (ted.charAddress & 0x0C00) !== 0;
  const out: string[] = [];
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 40; col++) {
      const code = mem.readByte((screen + row * 40 + col) & 0xFFFF) & 0xFF;
      line += c64TextChar(code, lower) ?? '#';
    }
    out.push(line.replace(/\s+$/, ''));
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
