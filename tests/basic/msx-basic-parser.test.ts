/**
 * MSX BASIC parser tests.
 *
 * The byte layouts follow the MSX-BASIC memory-format documentation:
 * https://www.msx.org/wiki/Internal_Structure_Of_BASIC_listing and the MSX2
 * Technical Handbook, figures 2.8 and 2.9. The HX-10 runs MSX BASIC 1.0,
 * which uses the same Microsoft BASIC 4.5 program and variable structures.
 */
import { describe, expect, it } from 'vitest';
import { parseMsxBasic, parseMsxBasicVariables } from '@/basic/msx-basic-parser.ts';
import type { BasicVariable } from '@/basic/types.ts';

const TXTTAB = 0xF676;
const VARTAB = 0xF6C2;
const ARYTAB = 0xF6C4;
const STREND = 0xF6C6;
const PROGRAM = 0x8001;

function word(mem: Uint8Array, addr: number, value: number): void {
  mem[addr] = value & 0xFF;
  mem[addr + 1] = value >> 8;
}

function basicRam(records: number[][]): Uint8Array {
  const ram = new Uint8Array(0x10000);
  word(ram, TXTTAB, PROGRAM);
  ram[PROGRAM] = 0;
  let addr = PROGRAM + 1;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const next = i + 1 === records.length ? 0 : addr + 2 + record.length;
    word(ram, addr, next);
    ram.set(record, addr + 2);
    addr += 2 + record.length;
  }
  word(ram, VARTAB, addr);
  word(ram, ARYTAB, addr);
  word(ram, STREND, addr);
  return ram;
}

function directBasicRam(records: number[][]): Uint8Array {
  const ram = basicRam(records);
  word(ram, TXTTAB, PROGRAM + 1);
  return ram;
}

describe('parseMsxBasic', () => {
  it('detokenizes keyword, integer, line-reference and function tokens', () => {
    // [line number] [tokenised body] [line terminator]. The 0x0D reference
    // points at the first record, where its line number follows the link word.
    const ram = basicRam([
      [10, 0, 0x91, 0x20, 0x0F, 42, 0],
      [20, 0, 0x89, 0x20, 0x0D, 2, 0x80, 0],
      [30, 0, 0x91, 0x20, 0xFF, 0x89, 0x28, 0x11, 0x29, 0],
    ]);
    expect(parseMsxBasic(ram)).toEqual([
      { lineNumber: 10, text: 'PRINT 42' },
      { lineNumber: 20, text: 'GOTO 10' },
      { lineNumber: 30, text: 'PRINT SIN(0)' },
    ]);
  });

  it('preserves token-looking bytes inside strings and normalizes compound tokens', () => {
    const ram = basicRam([
      [10, 0, 0x91, 0x20, 0x22, 0x89, 0x22, 0x3A, 0xA1, 0x20, 0x91, 0x20, 0x11, 0],
      [20, 0, 0x3A, 0x8F, 0xE6, 0x20, 0x74, 0x65, 0x73, 0x74, 0],
    ]);
    expect(parseMsxBasic(ram)).toEqual([
      { lineNumber: 10, text: 'PRINT \"\x89\"ELSE PRINT 0' },
      { lineNumber: 20, text: "' test" },
    ]);
  });

  it('decodes MSX BASIC packed-BCD single constants', () => {
    // 0x1D, positive exponent 1 (0x41 + 1), mantissa 1.23450 = 12.345.
    const ram = basicRam([[10, 0, 0x91, 0x20, 0x1D, 0x42, 0x12, 0x34, 0x50, 0]]);
    expect(parseMsxBasic(ram)).toEqual([{ lineNumber: 10, text: 'PRINT 12.345' }]);
  });

  it('accepts TXTTAB pointing directly to the first line record', () => {
    const ram = directBasicRam([[10, 0, 0x91, 0x20, 0x0F, 42, 0]]);
    expect(parseMsxBasic(ram)).toEqual([{ lineNumber: 10, text: 'PRINT 42' }]);
  });

  it('falls back to sequential records while BASIC line links are stale', () => {
    const ram = basicRam([
      [10, 0, 0x91, 0x20, 0x1C, 0x00, 0x01, 0],
      [20, 0, 0x91, 0x20, 0x0F, 42, 0],
    ]);
    // Link words can be temporarily stale during a BASIC load. The &H0100
    // constant deliberately contains a zero byte that is not a terminator.
    word(ram, PROGRAM + 1, 0x8FFF);
    expect(parseMsxBasic(ram)).toEqual([
      { lineNumber: 10, text: 'PRINT 256' },
      { lineNumber: 20, text: 'PRINT 42' },
    ]);
  });
});

describe('parseMsxBasicVariables', () => {
  it('decodes documented simple variables and an array descriptor', () => {
    const ram = basicRam([]);
    const vars = 0x8100;
    const arrays = 0x8112;
    const end = 0x8134;
    word(ram, VARTAB, vars);
    word(ram, ARYTAB, arrays);
    word(ram, STREND, end);

    // Integer A%=-5, string B$="HI", and single C=12.345.
    ram.set([0x02, 0x41, 0x00, 0xFB, 0xFF], vars);
    ram.set([0x03, 0x42, 0x00, 2, 0x00, 0x82], vars + 5);
    ram.set([0x04, 0x43, 0x00, 0x42, 0x12, 0x34, 0x50], vars + 11);
    ram.set([0x48, 0x49], 0x8200);

    // DIM AA%(2,3): stored extents are reversed (4, then 3), and each is N+1.
    ram.set([0x02, 0x41, 0x41, 0x1D, 0x00, 2, 4, 0, 3, 0], arrays);
    expect(parseMsxBasicVariables(ram)).toEqual<BasicVariable[]>([
      { name: 'A%', kind: 'number', value: '-5' },
      { name: 'B$', kind: 'string', value: 'HI' },
      { name: 'C', kind: 'number', value: '12.345' },
      { name: 'AA%(2,3)', kind: 'array' },
    ]);
  });

  it('returns no variables when the BASIC table pointers are invalid', () => {
    const ram = new Uint8Array(0x10000);
    word(ram, VARTAB, 0x9000);
    word(ram, ARYTAB, 0x8000);
    word(ram, STREND, 0x9000);
    expect(parseMsxBasicVariables(ram)).toEqual([]);
  });
});
