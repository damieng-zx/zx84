/**
 * Xtal BASIC (Tatung Einstein, xbas.com) listing parser tests.
 *
 * The byte layouts and the token table were reverse-engineered from a running
 * xbas.com RAM image; see docs/superpowers/specs/2026-07-20-einstein-xtal-basic-listing-design.md.
 *
 * Line record: [u16 length LE][u16 lineNumber LE][body...][0x00], where length
 * counts the whole record (length word through terminator). End of program is a
 * length word of 0x0000. The program text base is fixed at 0x3E01 in RAM.
 */
import { describe, expect, it } from 'vitest';
import { parseXtalBasic } from '@/basic/xtal-basic-parser.ts';

const PROG_START = 0x3E01;

/** Build a 64KB RAM image with the given records laid out from 0x3E01. */
function xtalRam(records: { line: number; body: number[] }[]): Uint8Array {
  const ram = new Uint8Array(0x10000);
  ram[PROG_START - 1] = 0; // the leading zero marker that precedes the program
  let addr = PROG_START;
  for (const { line, body } of records) {
    const length = 2 + 2 + body.length + 1; // len word + line word + body + 0x00
    ram[addr] = length & 0xFF;
    ram[addr + 1] = length >> 8;
    ram[addr + 2] = line & 0xFF;
    ram[addr + 3] = line >> 8;
    ram.set(body, addr + 4);
    ram[addr + 4 + body.length] = 0x00;
    addr += length;
  }
  // end-of-program marker
  ram[addr] = 0;
  ram[addr + 1] = 0;
  return ram;
}

// ASCII helper for readable bodies.
const a = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe('parseXtalBasic', () => {
  it('detokenizes a PRINT statement with a string literal', () => {
    // 10 PRINT "HELLO ";  =>  A2 20 22 H E L L O ' ' 22 3B
    const ram = xtalRam([
      { line: 10, body: [0xA2, 0x20, 0x22, ...a('HELLO '), 0x22, 0x3B] },
    ]);
    expect(parseXtalBasic(ram)).toEqual([
      { lineNumber: 10, text: 'PRINT "HELLO ";' },
    ]);
  });

  it('round-trips the reverse-engineered reference program (all record types)', () => {
    // The exact body bytes captured from a running xbas.com image. Numbers and
    // line references are stored as ASCII digits; '=' is token 0x7E, 'TO' 0x72.
    const ram = xtalRam([
      { line: 10, body: [0xA2, 0x20, 0x22, ...a('HELLO '), 0x22, 0x3B] },
      { line: 20, body: [0xA2, 0x20, ...a('A$')] },
      { line: 30, body: [0x91, 0x20, ...a('10')] },
      { line: 40, body: [0x95, 0x20, 0x4A, 0x7E, 0x31] },
      { line: 50, body: [0x8F, 0x20, 0x46, 0x7E, 0x31, 0x20, 0x72, 0x20, ...a('10')] },
      { line: 60, body: [0xA2, 0x20, 0x46] },
      { line: 70, body: [0x9B, 0x20, 0x46] },
    ]);
    expect(parseXtalBasic(ram)).toEqual([
      { lineNumber: 10, text: 'PRINT "HELLO ";' },
      { lineNumber: 20, text: 'PRINT A$' },
      { lineNumber: 30, text: 'GOTO 10' },
      { lineNumber: 40, text: 'LET J=1' },
      { lineNumber: 50, text: 'FOR F=1 TO 10' },
      { lineNumber: 60, text: 'PRINT F' },
      { lineNumber: 70, text: 'NEXT F' },
    ]);
  });

  it('never detokenizes token-range bytes inside a string literal', () => {
    // Lowercase letters (0x6F..0x7A) collide with operator tokens; a string
    // containing them and a raw 0x7E must pass through verbatim, not become '='.
    const ram = xtalRam([
      { line: 10, body: [0xA2, 0x20, 0x22, ...a('to~'), 0x22] },
    ]);
    // 'to~' = 0x74 0x6F 0x7E, all token bytes, but they are inside the string.
    expect(parseXtalBasic(ram)).toEqual([
      { lineNumber: 10, text: 'PRINT "to~"' },
    ]);
  });

  it('leaves the tail of a REM untokenized', () => {
    // REM (0xA4) then arbitrary bytes including a token-range byte 0x72.
    const ram = xtalRam([
      { line: 10, body: [0xA4, 0x20, ...a('go'), 0x72] },
    ]);
    expect(parseXtalBasic(ram)).toEqual([
      { lineNumber: 10, text: 'REM go\x72' },
    ]);
  });

  it('renders an unmapped high token via the {XX} fallback', () => {
    // 0xEA is past the primary table (extended graphics keyword territory).
    const ram = xtalRam([{ line: 10, body: [0xA2, 0x20, 0xEA] }]);
    expect(parseXtalBasic(ram)).toEqual([
      { lineNumber: 10, text: 'PRINT {EA}' },
    ]);
  });

  it('returns [] when RAM holds no valid program (not in BASIC)', () => {
    const ram = new Uint8Array(0x10000).fill(0xFF); // uninitialised filler
    expect(parseXtalBasic(ram)).toEqual([]);
  });

  it('stops cleanly at the 0x0000 end marker', () => {
    const ram = xtalRam([
      { line: 10, body: [0xA2, 0x20, 0x46] },
      { line: 20, body: [0x9B, 0x20, 0x46] },
    ]);
    // Anything after the marker must be ignored even if it looks like a record.
    expect(parseXtalBasic(ram).map((l) => l.lineNumber)).toEqual([10, 20]);
  });
});
