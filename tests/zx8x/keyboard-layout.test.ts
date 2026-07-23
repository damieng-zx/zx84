/**
 * ZX81 / ZX80 on-screen keyboard layout.
 *
 * The real machines have exactly 40 keys filling the 8×5 (rows × bits) matrix:
 * 26 letters + 10 digits + SHIFT + NEWLINE + SPACE + `.`. The cursor arrows,
 * RUBOUT, GRAPHICS, EDIT and BREAK are *shift legends* printed on existing keys,
 * not separate keys — so every on-screen key maps to exactly one matrix cell.
 *
 * These tests pin the on-screen layout to the emulator's own matrix so a typo or
 * a missing/duplicated key is caught, independent of the legend text.
 */

import { describe, it, expect } from 'vitest';
import { ZX81_ROWS, ZX80_ROWS, SHIFT, rowsForModel } from '@/machines/zx8x/ui/keyboard/legends.ts';

const allCells = (): string[] => {
  const cells: string[] = [];
  for (let row = 0; row < 8; row++) for (let bit = 0; bit < 5; bit++) cells.push(`${row},${bit}`);
  return cells.sort();
};

const cellsOf = (rows: { pos: readonly [number, number] }[][]): string[] =>
  rows.flat().map((k) => `${k.pos[0]},${k.pos[1]}`).sort();

describe.each([
  ['ZX81', ZX81_ROWS],
  ['ZX80', ZX80_ROWS],
])('%s on-screen layout', (_name, rows) => {
  it('covers all 40 matrix cells exactly once', () => {
    expect(cellsOf(rows)).toEqual(allCells());
  });

  it('is four rows of ten keys', () => {
    expect(rows.map((r) => r.length)).toEqual([10, 10, 10, 10]);
  });

  it('latches SHIFT at [0,0]', () => {
    const shift = rows.flat().find((k) => k.pos[0] === 0 && k.pos[1] === 0);
    expect(shift?.latch).toBe(true);
    expect(shift?.main).toBe('SHIFT');
  });

  it('gives every key a main glyph/label', () => {
    for (const k of rows.flat()) expect(k.main.length).toBeGreaterThan(0);
  });
});

// The canonical ZX81 K-mode keyword on each letter key, transcribed independently
// from the ZX81 keyboard (NOT from the implementation) so this pins the machine.
const ZX81_KEYWORDS: Record<string, string> = {
  Q: 'PLOT', W: 'UNPLOT', E: 'REM', R: 'RUN', T: 'RAND',
  Y: 'RETURN', U: 'IF', I: 'INPUT', O: 'POKE', P: 'PRINT',
  A: 'NEW', S: 'SAVE', D: 'DIM', F: 'FOR', G: 'GOTO',
  H: 'GOSUB', J: 'LOAD', K: 'LIST', L: 'LET',
  Z: 'COPY', X: 'CLEAR', C: 'CONT', V: 'CLS',
  B: 'SCROLL', N: 'NEXT', M: 'PAUSE',
};

// The FUNCTION word printed below each ZX81 letter key (V has none). The A/S/D
// keys print the full words ARCSIN/ARCCOS/ARCTAN on the case, even though the
// BASIC tokens are ASN/ACS/ATN.
const ZX81_FUNCS: Record<string, string> = {
  Q: 'SIN', W: 'COS', E: 'TAN', R: 'INT', T: 'RND',
  Y: 'STR$', U: 'CHR$', I: 'CODE', O: 'PEEK', P: 'TAB',
  A: 'ARCSIN', S: 'ARCCOS', D: 'ARCTAN', F: 'SGN', G: 'ABS',
  H: 'SQR', J: 'VAL', K: 'LEN', L: 'USR',
  Z: 'LN', X: 'EXP', C: 'AT', B: 'INKEY$', N: 'NOT', M: 'π',
};

describe('ZX81 legends pin the real keyboard', () => {
  const byMain = new Map(ZX81_ROWS.flat().map((k) => [k.main, k]));

  it('prints the canonical K-mode keyword on every letter key', () => {
    for (const [glyph, word] of Object.entries(ZX81_KEYWORDS)) {
      expect(byMain.get(glyph)?.keyword).toBe(word);
    }
  });

  it('prints the FUNCTION word below every letter key that has one', () => {
    for (const [glyph, word] of Object.entries(ZX81_FUNCS)) {
      expect(byMain.get(glyph)?.func).toBe(word);
    }
    expect(byMain.get('V')?.func).toBeUndefined();
  });

  it('prints the number-row edit/cursor/graphics functions above the keys', () => {
    expect(byMain.get('1')?.capFn).toBe('EDIT');
    expect(byMain.get('9')?.capFn).toBe('GRAPHICS');
    expect(byMain.get('0')?.capFn).toBe('RUBOUT');
    expect(['5', '6', '7', '8'].map((d) => byMain.get(d)?.capFn)).toEqual(['←', '↓', '↑', '→']);
  });

  it('leaves number keys without a K-mode keyword', () => {
    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
      expect(byMain.get(d)?.keyword).toBeUndefined();
    }
  });
});

describe('legends module', () => {
  it('SHIFT is the [0,0] modifier cell', () => {
    expect(SHIFT).toEqual([0, 0]);
  });

  it('rowsForModel selects the per-model table', () => {
    expect(rowsForModel('zx81')).toBe(ZX81_ROWS);
    expect(rowsForModel('zx80')).toBe(ZX80_ROWS);
  });
});
