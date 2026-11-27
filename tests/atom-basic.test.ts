/**
 * Acorn Atom BASIC text-space and variable parser, against the format in the
 * BASIC ROM source and the Atom Technical Manual's Block Zero tables.
 */

import { describe, expect, it } from 'vitest';
import { parseAtomBasic, parseAtomBasicVariables } from '@/basic/atom-basic-parser.ts';

/** Build a RAM image with Atom BASIC line records and scalar/array variables. */
function image(): Uint8Array {
  const ram = new Uint8Array(0x10000);
  ram[0x12] = 0x29;                       // text space page: $2900
  let p = 0x2900;
  const line = (number: number, text: string): void => {
    ram[p++] = 0x0d;
    ram[p++] = number >> 8;
    ram[p++] = number & 0xff;
    for (const ch of text) ram[p++] = ch.charCodeAt(0);
  };
  line(10, ' PRINT "HI"');
  line(20, ' END');
  ram[p++] = 0x0d;
  ram[p++] = 0xff;                        // end of program
  return ram;
}

describe('atom basic parser', () => {
  it('reads the untokenised line records from the text space', () => {
    expect(parseAtomBasic(image())).toEqual([
      { lineNumber: 10, text: ' PRINT "HI"' },
      { lineNumber: 20, text: ' END' },
    ]);
  });

  it('returns [] for an empty program and for RAM with no text space', () => {
    const empty = new Uint8Array(0x10000);
    empty[0x12] = 0x29;
    empty[0x2900] = 0x0d;
    empty[0x2901] = 0xff;
    expect(parseAtomBasic(empty)).toEqual([]);
    expect(parseAtomBasic(new Uint8Array(0x10000))).toEqual([]);
  });

  it('follows the 2 KB machine text space at $8200', () => {
    const ram = new Uint8Array(0x10000);
    ram[0x12] = 0x82;
    ram[0x8200] = 0x0d; ram[0x8201] = 0x00; ram[0x8202] = 0x05;
    for (const [i, ch] of [...' PRINT 1'].entries()) ram[0x8203 + i] = ch.charCodeAt(0);
    ram[0x820B] = 0x0d; ram[0x820C] = 0xff;
    expect(parseAtomBasic(ram)).toEqual([{ lineNumber: 5, text: ' PRINT 1' }]);
  });

  it('shows control codes in a line as readable braces', () => {
    const ram = image();
    ram[0x2900 + 3 + 6] = 0x0c;            // a form-feed inside line 10
    expect(parseAtomBasic(ram)[0].text).toContain('{0C}');
  });

  it('stops at the pseudo-record that introduces a saved machine-code block', () => {
    // BASIC line numbers are 15-bit; LIST stops when the high byte has bit 7
    // set. A program saved with an assembly block therefore ends at the
    // block's `$0D $E9 $02` record, not at a `$0D $FF` terminator.
    const ram = new Uint8Array(0x10000);
    ram[0x12] = 0x29;
    let p = 0x2900;
    for (const byte of [0x0d, 0x00, 0x01, ...Array.from(' PRINT 1', (c) => c.charCodeAt(0)), 0x0d, 0xe9, 0x02, 0xea, 0xea, 0x60]) {
      ram[p++] = byte;
    }
    expect(parseAtomBasic(ram)).toEqual([{ lineNumber: 1, text: ' PRINT 1' }]);
  });

  it('reads A-Z as four separate little-endian 32-bit columns', () => {
    const ram = image();
    ram[0x0322] = 42;                     // A low byte
    ram[0x0323] = 0xF9;                   // B low byte
    ram[0x033D + 1] = 0xFF;               // B = -7
    ram[0x0358 + 1] = 0xFF;
    ram[0x0373 + 1] = 0xFF;
    const vars = parseAtomBasicVariables(ram);
    expect(vars).toContainEqual({ name: 'A', kind: 'number', value: '42' });
    expect(vars).toContainEqual({ name: 'B', kind: 'number', value: '-7' });
    expect(vars.find((v) => v.name === 'C')).toBeUndefined();
  });

  it('derives AA-ZZ array dimensions from the allocation table and free pointer', () => {
    const ram = image();
    ram[0x02EC] = 0x02;                   // AA base low byte (slot 1), unaligned
    ram[0x0307] = 0x2A;                   // AA base high byte
    ram[0x0023] = 0x16;                   // free space $2A16
    ram[0x0024] = 0x2A;
    expect(parseAtomBasicVariables(ram)).toContainEqual({
      name: 'AA(4)', kind: 'array', detail: 'base $2A02',
    });
  });

  it('does not invent variables without a valid program', () => {
    const ram = new Uint8Array(0x10000);
    ram[0x0322] = 42;
    expect(parseAtomBasicVariables(ram)).toEqual([]);
  });
});
