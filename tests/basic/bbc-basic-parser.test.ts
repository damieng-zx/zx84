/**
 * BBC BASIC II detokeniser tests.
 *
 * The line-record layout (`[lineNoHi][lineNoLo][length][body…][&0D]`, single
 * length byte counting the whole record) and the token table were taken from
 * the ROM's keyword table at &8071-&836C and cross-checked against a worked
 * PAGE-upward hex dump (8bs.com) — the expectations below are worked out from
 * that spec, not from the parser.
 */
import { describe, expect, it } from 'vitest';
import { parseBbcBasic } from '@/basic/bbc-basic-parser.ts';

/** A record's bytes, given its line number and tokenised body. */
function record(line: number, body: number[]): number[] {
  const len = 4 + body.length;             // hi + lo + length byte + body + CR
  return [(line >> 8) & 0xFF, line & 0xFF, len, ...body, 0x0D];
}

/** A 32KB RAM image with `records` laid from PAGE plus the &FF terminator. */
function bbcRam(records: number[][], page = 0x0E00): Uint8Array {
  const ram = new Uint8Array(0x8000);
  ram[0x18] = page >> 8;                   // zero-page PAGE high byte
  let o = page;
  ram[o++] = 0x0D;                         // start-of-line marker at PAGE
  for (const r of records) { ram.set(r, o); o += r.length; }
  ram[o] = 0xFF;                           // end-of-program
  return ram;
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Encode a line number as the 3-byte reference that follows the &8D token. */
function lineRef(line: number): number[] {
  const ctrl = ((((line & 0x00C0) >> 2) | ((line & 0xC000) >> 12)) ^ 0x54) & 0xFF;
  return [0x8D, ctrl, ((line >> 0) & 0x3F) | 0x40, ((line >> 8) & 0x3F) | 0x40];
}

describe('parseBbcBasic', () => {
  it('detokenizes a PRINT with a string literal', () => {
    // PRINT "HELLO"  =>  F1 20 22 H E L L O 22
    const ram = bbcRam([record(10, [0xF1, 0x20, 0x22, ...ascii('HELLO'), 0x22])]);
    expect(parseBbcBasic(ram)).toEqual([{ lineNumber: 10, text: 'PRINT "HELLO"' }]);
  });

  it('expands the verified BASIC II tokens (AND=&80, DIV=&81, EOR=&82, LEFT$=&C0)', () => {
    // The task's suggested values were shifted by one (and LEFT$ by 0x20); the
    // ROM table at &8071 gives AND=&80, DIV=&81, EOR=&82, LEFT$=&C0.
    const ram = bbcRam([
      record(10, [0xF1, 0x20, 0x80, 0x20, 0x81, 0x20, 0x82, 0x20, 0xC0]),
    ]);
    expect(parseBbcBasic(ram)).toEqual([{ lineNumber: 10, text: 'PRINT AND DIV EOR LEFT$(' }]);
  });

  it('decodes the 3-byte line-number reference after GOTO', () => {
    // GOTO 10  =>  E5 20 [&8D 54 4A 40]
    const ram = bbcRam([record(20, [0xE5, 0x20, ...lineRef(10)])]);
    expect(parseBbcBasic(ram)).toEqual([{ lineNumber: 20, text: 'GOTO 10' }]);
  });

  it('round-trips a multi-line reference program against worked bytes', () => {
    // 10 PRINT "HI" / 20 GOTO 10 / 30 REM A comment
    const ram = bbcRam([
      record(10, [0xF1, 0x20, 0x22, ...ascii('HI'), 0x22]),
      record(20, [0xE5, 0x20, ...lineRef(10)]),
      record(30, [0xF4, 0x20, ...ascii('A comment')]),
    ]);
    expect(parseBbcBasic(ram)).toEqual([
      { lineNumber: 10, text: 'PRINT "HI"' },
      { lineNumber: 20, text: 'GOTO 10' },
      { lineNumber: 30, text: 'REM A comment' },
    ]);
  });

  it('detokenizes the assignment-form pseudo-variable token (&D0 = PAGE=)', () => {
    // PAGE=&2000  =>  D0 3D 26 32 30 30 30
    const ram = bbcRam([record(10, [0xD0, ...ascii('=&2000')])]);
    expect(parseBbcBasic(ram)).toEqual([{ lineNumber: 10, text: 'PAGE=&2000' }]);
  });

  it('leaves the tail of REM and DATA untokenized', () => {
    // A 0x80 byte after REM must stay a raw char, not expand to AND.
    const ram = bbcRam([
      record(10, [0xF4, 0x20, ...ascii('go '), 0x80]),
      record(20, [0xDC, 0x20, 0x80]),
    ]);
    expect(parseBbcBasic(ram)).toEqual([
      { lineNumber: 10, text: 'REM go \x80' },
      { lineNumber: 20, text: 'DATA \x80' },
    ]);
  });

  it('never expands token-range bytes inside a string literal', () => {
    // 0x80 inside quotes must pass through as a character, not become AND.
    const ram = bbcRam([record(10, [0xF1, 0x20, 0x22, 0x80, 0x22])]);
    expect(parseBbcBasic(ram)).toEqual([{ lineNumber: 10, text: 'PRINT "\x80"' }]);
  });

  it('locates the program at the DFS PAGE (&1900) from zero-page &18', () => {
    const ram = bbcRam([record(10, [0xF1, 0x20, 0x31])], 0x1900);
    expect(parseBbcBasic(ram)).toEqual([{ lineNumber: 10, text: 'PRINT 1' }]);
  });

  it('returns [] for an empty program (&0D &FF)', () => {
    expect(parseBbcBasic(bbcRam([]))).toEqual([]);
  });

  it('returns [] when RAM holds no valid program', () => {
    expect(parseBbcBasic(new Uint8Array(0x8000))).toEqual([]);
  });

  it('stops at the &FF terminator and ignores trailing garbage', () => {
    const ram = bbcRam([record(10, [0xF1, 0x20, 0x31])]);
    // A valid-looking record after the terminator must not be read.
    const terminator = 0x0E00 + 1 + (4 + 3); // PAGE + marker + first record
    ram.set(record(999, [0xF1, 0x20, 0x32]), terminator + 1);
    expect(parseBbcBasic(ram).map((l) => l.lineNumber)).toEqual([10]);
  });

  it('bails on a truncated record rather than reading past it', () => {
    const ram = bbcRam([record(10, [0xF1, 0x20, 0x31])]);
    ram[0x0E00 + 1 + 2] = 0xFF;              // absurd length byte
    expect(parseBbcBasic(ram)).toEqual([]);
  });
});