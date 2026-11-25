/**
 * BASIC 3.5 detokenisation, checked against the ROM's own keyword table
 * (basic-318006-01.rom at $818E) and the 3.5 additions the C64's V2 table does
 * not have.
 */

import { describe, it, expect } from 'vitest';
import { parsePlus4Basic, parsePlus4BasicVariables } from '@/basic/plus4-basic-parser.ts';
import { formatC64Float } from '@/basic/c64-basic-parser.ts';

/** A 64K RAM image holding one tokenised program line at $1001. */
function program(body: number[]): Uint8Array {
  const ram = new Uint8Array(0x10000);
  const line = 0x1001;
  const end = line + 4 + body.length + 1;
  ram[line] = end & 0xFF;
  ram[line + 1] = end >> 8;
  ram[line + 2] = 10;                 // line number 10
  ram[line + 3] = 0;
  ram.set(body, line + 4);
  ram[end - 1] = 0;                   // end of the line's text
  ram[end] = 0; ram[end + 1] = 0;     // the next link is zero
  // TXTTAB $2B, VARTAB $2D, ARYTAB $2F, STREND $31.
  for (const [at, value] of [[0x2B, line], [0x2D, end + 2], [0x2F, 0x9FFF], [0x31, 0x9FFF]] as const) {
    ram[at] = value & 0xFF; ram[at + 1] = value >> 8;
  }
  return ram;
}

const listing = (body: number[]): string => parsePlus4Basic(program(body)).map(l => l.text).join('\n');

describe('BASIC 3.5 listing', () => {
  it('decodes the 3.5 keywords the V2 table does not have', () => {
    // $EB DO, $EC LOOP, $FD WHILE, $ED EXIT, $FC UNTIL.
    expect(listing([0xEB, 0x20, 0xEC, 0x20, 0xFD, 0x20, 0x31, 0x3A, 0xED, 0x20, 0x31]))
      .toBe('DO LOOP WHILE 1:EXIT 1');
    // $CC RGR, $CD RCLR, $CE RLUM.
    expect(listing([0xCC, 0x28, 0x31, 0x2C, 0x32, 0x29, 0x3A, 0xCD, 0x3A, 0xCE, 0x20, 0x37]))
      .toBe('RGR(1,2):RCLR:RLUM 7');
  });

  it('keeps decoding the old tokens around them', () => {
    // IF A THEN SOUND 1,2: LOOP
    expect(listing([0x8B, 0x20, 0x41, 0x20, 0xA7, 0x20, 0xDA, 0x20, 0x31, 0x2C, 0x32, 0x3A, 0x20, 0xEC]))
      .toBe('IF A THEN SOUND 1,2: LOOP');
  });

  it('leaves a quoted string and a REM payload untokenised', () => {
    // PRINT "DO": REM DO LOOP
    expect(listing([0x99, 0x22, 0x44, 0x4F, 0x22, 0x3A, 0x8F, 0x20, 0x44, 0x4F]))
      .toBe('PRINT"DO":REM DO');
  });

  it('takes the tokens from the ROM, not from a truncation of them', () => {
    // $F8 RENUMBER is the last before $F9 KEY; $FD WHILE ends the table.
    expect(listing([0xF8, 0xF9, 0xFA, 0xFB, 0xFC, 0xFD]))
      .toBe('RENUMBERKEYMONITORUSINGUNTILWHILE');
    // $FE is not a token on the Plus/4: it is left as a control code.
    expect(listing([0xFE])).toBe('{$fe}');
  });

  it('still parses the variables with the 64 layout', () => {
    const ram = program([0x80]);
    // One real variable "A" = 1.5 at VARTAB: exponent $81, mantissa $C0.
    const vars = 0x1010;
    ram[0x2D] = vars & 0xFF; ram[0x2E] = vars >> 8;
    ram[0x2F] = (vars + 7) & 0xFF; ram[0x30] = (vars + 7) >> 8;
    ram[0x31] = (vars + 7) & 0xFF; ram[0x32] = (vars + 7) >> 8;
    ram[vars] = 0x41; ram[vars + 1] = 0x00;
    ram[vars + 2] = 0x81; ram[vars + 3] = 0x40; ram[vars + 4] = 0; ram[vars + 5] = 0; ram[vars + 6] = 0;
    expect(formatC64Float(ram, vars + 2)).toBe('1.5');
    expect(parsePlus4BasicVariables(ram)).toEqual([{ name: 'A', kind: 'number', value: '1.5' }]);
  });

  it('returns nothing when the pointers do not hold together', () => {
    const ram = program([0x80]);
    ram[0x2D] = 0x00; ram[0x2E] = 0x10;   // VARTAB below TXTTAB
    expect(parsePlus4Basic(ram)).toEqual([]);
  });
});
