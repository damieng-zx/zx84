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
import { parseBbcBasic, parseBbcBasicVariables } from '@/basic/bbc-basic-parser.ts';
import type { BasicVariable } from '@/basic/types.ts';

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

// ── Variables ─────────────────────────────────────────────────────────────
//
// The heap/pointer-table layout and the value encodings asserted below are
// taken from the BASIC II source (the ROM at &8000 is byte-identical to the
// `ivop/bbc-basic` reference build): entries are `[link:2][name…][&00][value]`
// chained through the table at &0480, the first name character is implied by
// the table slot, and values are 5-byte floats / 4-byte ints / string
// descriptors / arrays. Expectations are computed from that spec, not read back
// from the parser.

/** Write a little-endian word. */
function w16(ram: Uint8Array, a: number, v: number): void {
  ram[a] = v & 0xFF;
  ram[a + 1] = (v >> 8) & 0xFF;
}

/** Point the initial-character table slot for `first` at heap address `addr`. */
function setHead(ram: Uint8Array, first: string, addr: number): void {
  w16(ram, 0x0400 + first.charCodeAt(0) * 2, addr);
}

/** Heap entry `[link:2][name chars][&00][value]` at `at`; returns `at`. */
function putEntry(ram: Uint8Array, at: number, name: string, value: number[], link = 0): number {
  let i = at;
  ram[i++] = link & 0xFF;
  ram[i++] = (link >> 8) & 0xFF;
  for (const c of name) ram[i++] = c.charCodeAt(0);
  ram[i++] = 0x00;
  ram.set(value, i);
  return at;
}

/** A 5-byte BASIC II float: exponent, then sign+mantissa MSB-first. */
const flt = (exp: number, m1: number, m2 = 0, m3 = 0, m4 = 0): number[] => [exp, m1, m2, m3, m4];
/** A 4-byte signed integer. */
const int32 = (v: number): number[] => [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF];

/** Build a full image: resident ints, one of every heap kind, and a live FOR. */
function fullVariableImage(): Uint8Array {
  const ram = new Uint8Array(0x8000);
  w16(ram, 0x00, 0x2000);                    // LOMEM
  const vartop = 0x2074;
  w16(ram, 0x02, vartop);                    // VARTOP

  // Resident integer variables, 4 bytes each from &0404 (A%).
  w16(ram, 0x0404, 7);                       // A% = 7
  w16(ram, 0x0408, 42);                      // B% = 42
  ram.set(int32(-3), 0x0410);                // D% = -3

  // Heap, laid out in creation order.
  putEntry(ram, 0x2000, '', flt(0x82, 0x60));            // A  = 3.5
  setHead(ram, 'A', 0x2000);
  putEntry(ram, 0x2008, 'B%', int32(42));                // BB% = 42
  setHead(ram, 'B', 0x2008);

  // C$ = "HI"; the descriptor points at the two characters that follow it.
  putEntry(ram, 0x2011, '$', [0x19, 0x20, 0x02, 0x02, 0x48, 0x49]); // start=&2019
  setHead(ram, 'C', 0x2011);

  putEntry(ram, 0x201B, '(', [0x03, 0x04, 0x00, ...new Array(20).fill(0)]); // X(3)
  setHead(ram, 'X', 0x201B);
  putEntry(ram, 0x2036, '%(', [0x05, 0x03, 0x00, 0x02, 0x00, ...new Array(24).fill(0)]); // Y%(2,1)
  setHead(ram, 'Y', 0x2036);
  putEntry(ram, 0x2058, '$(', [0x03, 0x03, 0x00, ...new Array(12).fill(0)]); // Z$(2)
  setHead(ram, 'Z', 0x2058);

  putEntry(ram, 0x206C, '', flt(0x81, 0x00));             // I  = 1.0
  setHead(ram, 'I', 0x206C);

  // One live FOR I = 1 TO 5 STEP 2 frame: value address &206F.
  ram[0x26] = 0x0F;
  ram.set([0x6F, 0x20, 0x05, ...flt(0x82, 0x00), ...flt(0x83, 0x20), 0x68, 0x0E], 0x0500);
  return ram;
}

describe('parseBbcBasicVariables', () => {
  it('decodes resident ints, every heap kind, and a live FOR loop', () => {
    expect(parseBbcBasicVariables(fullVariableImage())).toEqual<BasicVariable[]>([
      { name: 'A%', kind: 'number', value: '7' },
      { name: 'B%', kind: 'number', value: '42' },
      { name: 'D%', kind: 'number', value: '-3' },
      { name: 'A', kind: 'number', value: '3.5' },
      { name: 'BB%', kind: 'number', value: '42' },
      { name: 'C$', kind: 'string', value: 'HI' },
      { name: 'X(3)', kind: 'array' },
      { name: 'Y%(2,1)', kind: 'array' },
      { name: 'Z$(2)', kind: 'array' },
      // The loop variable is shown once, as the loop, not as `I = 1`.
      { name: 'I', kind: 'for-next', value: '1', detail: 'TO 5 STEP 2' },
    ]);
  });

  it('follows the same-initial-character link chain', () => {
    // Table slot 'A' heads a two-entry chain: AA = 1.0 then AB = 2.0.
    const ram = new Uint8Array(0x8000);
    w16(ram, 0x00, 0x2000);
    w16(ram, 0x02, 0x2012);
    putEntry(ram, 0x2000, 'A', flt(0x81, 0x00), 0x2009); // AA, link→AB
    putEntry(ram, 0x2009, 'B', flt(0x82, 0x00));          // AB
    setHead(ram, 'A', 0x2000);
    expect(parseBbcBasicVariables(ram)).toEqual<BasicVariable[]>([
      { name: 'AA', kind: 'number', value: '1' },
      { name: 'AB', kind: 'number', value: '2' },
    ]);
  });

  it('decodes a negative float and an integer held with a zero exponent', () => {
    // N = -3.5 (sign bit set in the mantissa MSB), Z = 0 (exponent 0).
    const ram = new Uint8Array(0x8000);
    w16(ram, 0x00, 0x2000);
    w16(ram, 0x02, 0x2012);
    putEntry(ram, 0x2000, '', flt(0x82, 0xE0));
    setHead(ram, 'N', 0x2000);
    putEntry(ram, 0x2008, '', [0x00, 0x00, 0x00, 0x00, 0x00]);
    setHead(ram, 'Z', 0x2008);
    expect(parseBbcBasicVariables(ram)).toEqual<BasicVariable[]>([
      { name: 'N', kind: 'number', value: '-3.5' },
      { name: 'Z', kind: 'number', value: '0' },
    ]);
  });

  it('reads a relocated string from the descriptor, not the following bytes', () => {
    // S$ descriptor points at &4000; its entry sits at &3000.
    const ram = new Uint8Array(0x8000);
    w16(ram, 0x00, 0x3000);
    w16(ram, 0x02, 0x4010);
    putEntry(ram, 0x3000, '$', [0x00, 0x40, 0x05, 0x05]);
    setHead(ram, 'S', 0x3000);
    ram.set([...'WORLD'].map((c) => c.charCodeAt(0)), 0x4000);
    expect(parseBbcBasicVariables(ram)).toEqual<BasicVariable[]>([
      { name: 'S$', kind: 'string', value: 'WORLD' },
    ]);
  });

  it('lists non-zero resident integers even with an empty heap', () => {
    const ram = new Uint8Array(0x8000);
    w16(ram, 0x00, 0x2000);
    w16(ram, 0x02, 0x2000);                  // LOMEM == VARTOP: no heap vars
    w16(ram, 0x0404, 5);                     // A% = 5
    expect(parseBbcBasicVariables(ram)).toEqual<BasicVariable[]>([
      { name: 'A%', kind: 'number', value: '5' },
    ]);
  });

  it('returns [] for blank RAM', () => {
    expect(parseBbcBasicVariables(new Uint8Array(0x8000))).toEqual([]);
  });

  it('ignores table pointers that fall outside the heap', () => {
    const ram = new Uint8Array(0x8000);
    w16(ram, 0x00, 0x2000);
    w16(ram, 0x02, 0x2010);
    setHead(ram, 'A', 0x5000);               // beyond VARTOP
    expect(parseBbcBasicVariables(ram)).toEqual([]);
  });
});