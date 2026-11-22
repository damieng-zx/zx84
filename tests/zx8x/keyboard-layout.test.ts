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
import { ZX81_ROWS, ZX80_ROWS, TS1500_ROWS, SHIFT, rowsForModel } from '@/machines/zx8x/ui/keyboard/legends.ts';

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
  ['TS1500', TS1500_ROWS],
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

// What the Timex Sinclair 1500's own keycaps print, read key by key from a
// photograph of the machine (not from the implementation): the shifted symbol or
// word at the foot of the cap, in the order of the four key rows.
const TS1500_SHIFTED: Record<string, string> = {
  Q: '""', W: 'OR', E: 'STEP', R: '<=', T: '<>', Y: '>=', U: '$', I: '(', O: ')', P: '"',
  A: 'STOP', S: 'LPRINT', D: 'SLOW', F: 'FAST', G: 'LLIST', H: '**', J: '−', K: '+', L: '=',
  Z: ':', X: ';', C: '?', V: '/', B: '*', N: '<', M: '>', '.': ',',
};

describe('TS1500 legends pin the real keyboard', () => {
  const byMain = new Map(TS1500_ROWS.flat().map((k) => [k.main, k]));

  it('prints the ZX81 K-mode keyword above and FUNCTION word below every letter key', () => {
    for (const [glyph, word] of Object.entries(ZX81_KEYWORDS)) expect(byMain.get(glyph)?.keyword, glyph).toBe(word);
    for (const [glyph, word] of Object.entries(ZX81_FUNCS)) expect(byMain.get(glyph)?.func, glyph).toBe(word);
    expect(byMain.get('V')?.func).toBeUndefined();
  });

  it('prints the shifted symbol or word on every key that has one', () => {
    for (const [glyph, text] of Object.entries(TS1500_SHIFTED)) expect(byMain.get(glyph)?.shift, glyph).toBe(text);
  });

  it('prints EDIT, AND, THEN, TO and the cursor arrows on 1-8, GRAPHICS on 9 and DELETE (not RUBOUT) on 0', () => {
    expect(['1', '2', '3', '4'].map((d) => byMain.get(d)?.capFn)).toEqual(['EDIT', 'AND', 'THEN', 'TO']);
    expect(['5', '6', '7', '8'].map((d) => byMain.get(d)?.capFn)).toEqual(['←', '↓', '↑', '→']);
    expect(byMain.get('9')?.capFn).toBe('GRAPHICS');
    expect(byMain.get('0')?.capFn).toBe('DELETE');
  });

  it('has one ENTER / FUNCTION key where the ZX81 has NEW LINE, on the same matrix cell, and BREAK over SPACE', () => {
    const enter = TS1500_ROWS[2][9];
    expect(enter.main).toBe('ENTER\nFUNCTION');
    expect(enter.capFn).toBeUndefined();
    expect(enter.pos).toEqual(ZX81_ROWS[2][9].pos);
    expect(byMain.get('SPACE')?.keyword).toBe('BREAK');
    expect(byMain.get('SPACE')?.shift).toBe('£');
  });

  it('puts every key on the same matrix cell as the ZX81, in the same place in its row', () => {
    TS1500_ROWS.forEach((row, r) => row.forEach((k, c) => expect(k.pos, `row ${r} key ${c}`).toEqual(ZX81_ROWS[r][c].pos)));
  });

  it('leaves the number keys without a K-mode keyword', () => {
    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) expect(byMain.get(d)?.keyword).toBeUndefined();
  });
});

describe('legends module', () => {
  it('SHIFT is the [0,0] modifier cell', () => {
    expect(SHIFT).toEqual([0, 0]);
  });

  it('rowsForModel selects the per-model table: the TS1500 has its own, the TS1000 the ZX81\'s', () => {
    expect(rowsForModel('zx81')).toBe(ZX81_ROWS);
    expect(rowsForModel('zx80')).toBe(ZX80_ROWS);
    expect(rowsForModel('ts1500')).toBe(TS1500_ROWS);
    expect(rowsForModel('ts1000')).toBe(ZX81_ROWS);
  });
});
