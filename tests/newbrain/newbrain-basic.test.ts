import { describe, it, expect } from 'vitest';
import {
  parseNewBrainBasic, parseNewBrainBasicVariables, newBrainFloat, newBrainSymbolName,
} from '@/basic/newbrain-basic-parser.ts';

const BASE = 0x0900;

/** Name/type word for a variable: 37 x first letter + second (36 = none). */
function nt(name: string, flags = 0x8000): number {
  const first = name.charCodeAt(0) - 0x41;
  const second = name.length > 1 ? name.charCodeAt(1) - 0x41 : 36;
  return flags | (first * 37 + second);
}

/** A 6-byte float from its documented parts: sign, base-256 exponent, 40-bit mantissa. */
function fp(sign: number, exp: number, mantissa: number[]): number[] {
  return [((exp & 0x7F) << 1) | sign, ...mantissa];
}

interface Image {
  /** Source lines as [line number, bytes without the CR]. */
  lines: [number, number[]][];
  /** 8-byte symbol entries, oldest first (the table is laid out newest first). */
  symbols?: number[][];
  /** Strings, placed just under ARBAS. */
  strings?: number[];
  /** Array elements, just under SBAS. */
  arrays?: number[];
  /** FOR blocks, innermost first. */
  fors?: number[][];
  /** GOSUB entries. */
  gosubs?: number[][];
}

/** Lay out a BASIC block the way the OS documents it and return the 32K of RAM. */
function build(img: Image): Uint8Array {
  const mem = new Uint8Array(0x8000);
  const w = (a: number, v: number) => { mem[a] = v & 0xFF; mem[a + 1] = (v >> 8) & 0xFF; };
  w(0x04, BASE);
  let p = BASE + 61;
  const src: number[] = [];
  const lnt: [number, number][] = [];
  for (const [n, bytes] of img.lines) { lnt.push([n, p + src.length]); src.push(...bytes, 0x0D); }
  mem.set(src, p);
  const stop = p + src.length;
  const fors = (img.fors ?? []).flat();
  const gosubs = (img.gosubs ?? []).flat();
  const strings = img.strings ?? [];
  const arrays = img.arrays ?? [];
  const symbols = [...(img.symbols ?? [])].reverse().flat();
  const forptr = stop + 16;                          // the object code and free space between
  const gssptr = forptr + fors.length;
  const stbas = gssptr + gosubs.length;
  const arbas = stbas + strings.length;
  const sbas = arbas + arrays.length;
  const lbas = sbas + symbols.length;
  const top = lbas + lnt.length * 6;
  w(BASE + 0x0E, stop); w(BASE + 0x10, stop); w(BASE + 0x12, forptr);
  w(BASE + 0x14, forptr); w(BASE + 0x16, gssptr); w(BASE + 0x18, stbas);
  w(BASE + 0x1A, arbas); w(BASE + 0x1C, sbas); w(BASE + 0x1E, lbas); w(BASE + 0x20, top);
  mem.set(fors, forptr); mem.set(gosubs, gssptr); mem.set(strings, stbas);
  mem.set(arrays, arbas); mem.set(symbols, sbas);
  lnt.forEach(([n, ptr], i) => { w(lbas + i * 6, n); w(lbas + i * 6 + 2, ptr); });
  return mem;
}

const text = (s: string) => Array.from(s, c => c.charCodeAt(0));

describe('NewBrain BASIC listing', () => {
  it('reads statement keywords at the start of a line and words elsewhere from the same byte values', () => {
    // 0x8B is FOR first in the line; 0x8C is "=" after it (the same byte, NEXT, starts another statement).
    const mem = build({ lines: [[10, [0x20, 0x8B, 0x20, ...text('i'), 0x8C, ...text('1'), 0x20, 0xB6, 0x20, ...text('5')]]] });
    expect(parseNewBrainBasic(mem)).toEqual([{ lineNumber: 10, text: 'FOR i=1 TO 5' }]);
  });

  it('starts a new statement after the semicolon and invisible THEN the tokeniser leaves, and after THEN', () => {
    const mem = build({
      lines: [
        [20, [0x20, 0x83, 0x20, ...text('i;'), 0x20, 0xB5, 0x8C, 0x20, ...text('i')]],           // PRINT i; NEXT i
        [30, [0x20, 0x89, 0x20, ...text('a'), 0x8D, ...text('1'), 0x20, 0xB4, 0x20, 0x85, ...text(' 100')]], // IF a>1 THEN GOTO 100
      ],
    });
    expect(parseNewBrainBasic(mem)).toEqual([
      { lineNumber: 20, text: 'PRINT i; NEXT i' },
      { lineNumber: 30, text: 'IF a>1 THEN GOTO 100' },
    ]);
  });

  it('never tokenises a quoted string, a REM, or the rest of a DATA statement', () => {
    const mem = build({
      lines: [
        [1, [0x20, 0x83, 0x20, 0x22, ...text('a;b'), 0x83, 0x22]],                // PRINT "a;b<0x83>"
        [2, [0x20, 0x8E, ...text(' x;y'), 0x83, ...text('z')]],                   // REM x;y<0x83>z
        [3, [0x20, 0x9D, ...text(' 1,"2;3",4;'), 0x20, 0xB5, 0x83, ...text(' 5')]], // DATA ...; PRINT 5
      ],
    });
    expect(parseNewBrainBasic(mem)).toEqual([
      { lineNumber: 1, text: 'PRINT "a;b{$83}"' },
      { lineNumber: 2, text: 'REM x;y{$83}z' },
      { lineNumber: 3, text: 'DATA 1,"2;3",4; PRINT 5' },
    ]);
  });

  it('skips the command line (line 0) and joins several entries of one line number', () => {
    const mem = build({
      lines: [
        [0, [...text('cmd')]],
        [10, [0x20, 0x83, ...text(' 1')]],
        [10, [0x20, 0x83, ...text(' 2')]],
        [20, [0x20, 0x8F]],
      ],
    });
    expect(parseNewBrainBasic(mem)).toEqual([
      { lineNumber: 10, text: 'PRINT 1; PRINT 2' },
      { lineNumber: 20, text: 'END' },
    ]);
  });

  it('returns nothing when the pointers do not describe a BASIC block', () => {
    expect(parseNewBrainBasic(new Uint8Array(0x8000))).toEqual([]);
    const mem = build({ lines: [[10, [0x20, 0x8F]]] });
    mem[BASE + 0x20] = 0xFF;                           // TOP no longer follows LBAS in 6-byte entries
    expect(parseNewBrainBasic(mem)).toEqual([]);
    expect(parseNewBrainBasic(new Uint8Array(100))).toEqual([]);
  });
});

describe('NewBrain 6-byte floats', () => {
  it('holds the base-256 exponent doubled with the sign in the low bit, over a 40-bit mantissa', () => {
    const rd = (b: number[]) => newBrainFloat(Uint8Array.from(b), 0);
    expect(rd(fp(0, 1, [0x03, 0, 0, 0, 0]))).toBe(3);
    expect(rd(fp(1, 1, [0x03, 0, 0, 0, 0]))).toBe(-3);
    expect(rd(fp(0, 1, [0xFA, 0, 0, 0, 0]))).toBe(250);
    expect(rd(fp(0, 0, [0x80, 0, 0, 0, 0]))).toBe(0.5);
    expect(rd(fp(0, 2, [0x30, 0x39, 0xAD, 0xCC, 0x63]))).toBeCloseTo(12345.6789, 6);
    expect(rd(fp(0, -1, [0x41, 0x89, 0x37, 0x4B, 0xCC]))).toBeCloseTo(0.001, 12);
    expect(rd([0, 0, 0, 0, 0, 0])).toBe(0);
  });
});

describe('NewBrain symbol names', () => {
  it('spells 37 x first letter + second character, with 36 for none and 26-35 for a digit', () => {
    expect(newBrainSymbolName(nt('A'))).toBe('A');
    expect(newBrainSymbolName(nt('Q'))).toBe('Q');
    expect(newBrainSymbolName(nt('AB'))).toBe('AB');
    expect(newBrainSymbolName(37 * 23 + 26 + 1)).toBe('X1');
    expect(newBrainSymbolName(nt('F', 0x8000 | 0x4000))).toBe('F$');
  });
});

describe('NewBrain BASIC variables', () => {
  const entry = (name: number, rest: number[]) => [name & 0xFF, name >> 8, ...rest];

  it('lists numbers and strings in the order they were made, skipping constants', () => {
    const mem = build({
      lines: [],
      strings: text('hello'),
      symbols: [
        entry(0x0000, fp(0, 1, [0x03, 0, 0, 0, 0])),                            // the constant 3
        entry(nt('E'), fp(0, 2, [0x30, 0x39, 0xAD, 0xCC, 0x63])),               // E = 12345.6789
        entry(nt('F', 0xC000), [0xFB, 0xFF, 0x05, 0x00, 0x00, 0x00]),            // F$ = "hello" (5 under ARBAS)
        entry(nt('Q'), fp(1, 1, [0xFA, 0, 0, 0, 0])),                           // Q = -250
      ],
    });
    expect(parseNewBrainBasicVariables(mem)).toEqual([
      { name: 'E', kind: 'number', value: '12345.6789' },
      { name: 'F$', kind: 'string', value: 'hello' },
      { name: 'Q', kind: 'number', value: '-250' },
    ]);
  });

  it('shows arrays by their highest subscript, one and two dimensional', () => {
    const mem = build({
      lines: [],
      arrays: new Array(24 + 54).fill(0),
      symbols: [
        entry(nt('A', 0x9000), [0xE8, 0xFF, 0x04, 0x00, 0x01, 0x00]),            // A(3): 4 elements
        entry(nt('B', 0x8000 | 0x4000 | 0x2000), [0xB2, 0xFF, 0x03, 0x00, 0x03, 0x00]), // B$(2,2)
      ],
    });
    expect(parseNewBrainBasicVariables(mem)).toEqual([
      { name: 'A(3)', kind: 'array' },
      { name: 'B$(2,2)', kind: 'array' },
    ]);
  });

  it('lists the running FOR loops, innermost first, with the variable current value and limits', () => {
    const forBlock = (varName: string, step: number[], limit: number[]) =>
      [0x1E, 0, 0, 0x14, 0, 0, ...step, ...limit, nt(varName) & 0xFF, nt(varName) >> 8];
    const mem = build({
      lines: [],
      symbols: [
        entry(nt('I'), fp(0, 1, [0x01, 0, 0, 0, 0])),
        entry(nt('J'), fp(0, 1, [0x02, 0, 0, 0, 0])),
      ],
      fors: [
        forBlock('J', fp(0, 1, [0x03, 0, 0, 0, 0]), fp(0, 1, [0x08, 0, 0, 0, 0])),   // FOR J=2 TO 8 STEP 3
        forBlock('I', fp(0, 1, [0x01, 0, 0, 0, 0]), fp(0, 1, [0x05, 0, 0, 0, 0])),   // FOR I=1 TO 5
      ],
      gosubs: [[0x19, 0, 0]],
    });
    const vars = parseNewBrainBasicVariables(mem);
    expect(vars.filter(v => v.kind === 'for-next')).toEqual([
      { name: 'J', kind: 'for-next', value: '2', detail: 'TO 8 STEP 3' },
      { name: 'I', kind: 'for-next', value: '1', detail: 'TO 5' },
    ]);
  });

  it('returns nothing for RAM that holds no BASIC block', () => {
    expect(parseNewBrainBasicVariables(new Uint8Array(0x8000))).toEqual([]);
  });
});
