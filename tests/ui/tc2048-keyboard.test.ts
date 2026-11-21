import { describe, expect, it } from 'vitest';
import {
  TC2048_ROWS,
  TC2048_SCENE,
  placeTc2048Rows,
} from '@/machines/spectrum/ui/keyboard/tc2048-keyboard.ts';

const keys = TC2048_ROWS.flat();
const byMain = (main: string) => keys.filter((k) => k.main === main);
const one = (main: string) => {
  const found = byMain(main);
  expect(found, main).toHaveLength(1);
  return found[0];
};

// What the Timex Computer 2048's own keycaps print, read key by key from a
// photograph of the machine (not from the implementation).
describe('TC2048 keyboard layout', () => {
  it('has 42 keys: ten digits, ten, ten, eleven in the bottom row and a space bar', () => {
    expect(TC2048_ROWS.map((r) => r.length)).toEqual([10, 10, 10, 11, 1]);
    expect(keys).toHaveLength(42);
  });

  it('reads the keys in the order the photo shows them', () => {
    const labels = TC2048_ROWS.map((r) => r.map((k) => k.main.replace('\n', ' ')).join(' '));
    expect(labels).toEqual([
      '1 2 3 4 5 6 7 8 9 0',
      'Q W E R T Y U I O P',
      'A S D F G H J K L ENTER',
      'CAPS SHIFT Z X C V B N M SYMBL SHIFT BREAK CAPS SHIFT',
      'SPACE',
    ]);
  });

  it('covers every cell of the 8x5 matrix', () => {
    const covered = new Set(keys.flatMap((k) => k.cells.map(([r, b]) => `${r},${b}`)));
    for (let row = 0; row < 8; row++) for (let bit = 0; bit < 5; bit++) expect(covered.has(`${row},${bit}`), `${row},${bit}`).toBe(true);
    expect(covered.size).toBe(40);
  });

  it('wires the Spectrum matrix: Q and P, A and L, Z and M, the digits, ENTER, SPACE', () => {
    expect(one('Q').cells).toEqual([[2, 0]]);
    expect(one('P').cells).toEqual([[5, 0]]);
    expect(one('A').cells).toEqual([[1, 0]]);
    expect(one('L').cells).toEqual([[6, 1]]);
    expect(one('Z').cells).toEqual([[0, 1]]);
    expect(one('M').cells).toEqual([[7, 2]]);
    expect(one('1').cells).toEqual([[3, 0]]);
    expect(one('6').cells).toEqual([[4, 4]]);
    expect(one('0').cells).toEqual([[4, 0]]);
    expect(one('ENTER').cells).toEqual([[6, 0]]);
    expect(one('SPACE').cells).toEqual([[7, 0]]);
  });

  it('has two CAPS SHIFT keys on one cell, one SYMBL SHIFT, and a BREAK that holds CAPS SHIFT and SPACE', () => {
    const caps = byMain('CAPS\nSHIFT');
    expect(caps).toHaveLength(2);
    for (const k of caps) {
      expect(k.cells).toEqual([[0, 0]]);
      expect(k.latch).toBe('oneshot');
    }
    expect(one('SYMBL\nSHIFT').cells).toEqual([[7, 1]]);
    expect(one('SYMBL\nSHIFT').dark).toBe(true);
    expect(one('BREAK').cells).toEqual([[0, 0], [7, 0]]);
    expect(one('BREAK').latch).toBeUndefined();
  });
});

describe('TC2048 legends', () => {
  it('prints the colour names over 1-7 and 0, and nothing over 8 and 9', () => {
    expect('1234567890'.split('').map((d) => one(d).colour)).toEqual(
      ['BLUE', 'RED', 'MAGENTA', 'GREEN', 'CYAN', 'YELLOW', 'WHITE', undefined, undefined, 'BLACK'],
    );
  });

  it('prints the commands over the digits and the extended-mode words under them', () => {
    expect('1234567890'.split('').map((d) => one(d).above)).toEqual(
      ['EDIT', 'CAPS LOCK', 'TRUE VIDEO', 'INV. VIDEO', '←', '↓', '↑', '→', 'GRAPHICS', 'DELETE'],
    );
    expect('1234567890'.split('').map((d) => one(d).below)).toEqual(
      ['DEF FN', 'FN', 'LINE', 'OPEN #', 'CLOSE #', 'MOVE', 'ERASE', 'POINT', 'CAT', 'FORMAT'],
    );
  });

  it('prints the symbol-shift symbols in the strip on each digit', () => {
    expect('1234567890'.split('').map((d) => one(d).strip)).toEqual(
      ['!', '@', '#', '$', '%', '&', "'", '(', ')', '_'],
    );
  });

  it('prints a block-graphics swatch on 1-8 only', () => {
    expect('12345678'.split('').map((d) => one(d).block)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(one('9').block).toBeUndefined();
    expect(one('0').block).toBeUndefined();
  });

  it('prints the function word above and the extended keyword below every letter', () => {
    const above = 'QWERTYUIOP ASDFGHJKL ZXCVBNM'.replace(/ /g, '').split('').map((c) => one(c).above);
    expect(above).toEqual([
      'SIN', 'COS', 'TAN', 'INT', 'RND', 'STR $', 'CHR $', 'CODE', 'PEEK', 'TAB',
      'READ', 'RESTORE', 'DATA', 'SGN', 'ABS', 'SQR', 'VAL', 'LEN', 'USR',
      'LN', 'EXP', 'L PRINT', 'L LIST', 'BIN', 'INKEY $', 'PI',
    ]);
    const below = 'QWERTYUIOPASDFGHJKLZXCVBNM'.split('').map((c) => one(c).below);
    expect(below).toEqual([
      'ASN', 'ACS', 'ATN', 'VERIFY', 'MERGE', '[', ']', 'IN', 'OUT', '©',
      '~', '|', '\\', '{', '}', 'CIRCLE', 'VAL $', 'SCREEN $', 'ATTR',
      'BEEP', 'INK', 'PAPER', 'FLASH', 'BRIGHT', 'OVER', 'INVERSE',
    ]);
  });

  it('prints the K-mode keyword and the symbol-shift legend on every letter cap', () => {
    const keyword = 'QWERTYUIOPASDFGHJKLZXCVBNM'.split('').map((c) => one(c).keyword);
    expect(keyword).toEqual([
      'PLOT', 'DRAW', 'REM', 'RUN', 'RAND', 'RETRN', 'IF', 'INPUT', 'POKE', 'PRINT',
      'NEW', 'SAVE', 'DIM', 'FOR', 'GOTO', 'GOSUB', 'LOAD', 'LIST', 'LET',
      'COPY', 'CLEAR', 'CONT', 'CLS', 'BORDR', 'NEXT', 'PAUSE',
    ]);
    const strip = 'QWERTYUIOPASDFGHJKLZXCVBNM'.split('').map((c) => one(c).strip);
    expect(strip).toEqual([
      '<=', '<>', '>=', '<', '>', 'AND', 'OR', 'AT', ';', '"',
      'STOP', 'NOT', 'STEP', 'TO', 'THEN', '↑', '−', '+', '=',
      ':', '£', '?', '/', '*', ',', '.',
    ]);
  });

  it('spells RETURN and BORDER the TC2048 way', () => {
    expect(one('Y').keyword).toBe('RETRN');
    expect(one('B').keyword).toBe('BORDR');
  });

  it('prints nothing on the case around the keys that are not letters or digits', () => {
    for (const main of ['ENTER', 'SPACE', 'BREAK', 'SYMBL\nSHIFT']) {
      const k = one(main);
      expect([k.above, k.below, k.colour, k.keyword, k.strip], main).toEqual([undefined, undefined, undefined, undefined, undefined]);
    }
  });
});

describe('TC2048 geometry', () => {
  const placed = placeTc2048Rows(TC2048_ROWS);
  const at = (index: number) => placed[index];
  const rowOf = (r: number) => {
    const start = TC2048_ROWS.slice(0, r).reduce((n, row) => n + row.length, 0);
    return placed.slice(start, start + TC2048_ROWS[r].length);
  };

  it('places every key, with its cell and legends, inside the scene', () => {
    expect(placed).toHaveLength(42);
    for (const { cell, cap, above, below } of placed) {
      for (const box of [cell, cap, above, below]) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(TC2048_SCENE.width);
        expect(box.y + box.height).toBeLessThanOrEqual(TC2048_SCENE.height);
      }
      expect(cap.x).toBeGreaterThanOrEqual(cell.x);
      expect(cap.x + cap.width).toBeLessThanOrEqual(cell.x + cell.width);
      expect(cap.y).toBeGreaterThan(cell.y);
      expect(cap.y + cap.height).toBeLessThan(cell.y + cell.height);
    }
  });

  it('keeps the photo\'s stagger: the second row half a pitch in, the third three-quarters, the fourth flush', () => {
    const pitch = at(1).cell.x - at(0).cell.x;
    expect(pitch).toBe(49);
    expect(rowOf(1)[0].cell.x - rowOf(0)[0].cell.x).toBe(pitch / 2);
    expect(rowOf(2)[0].cell.x - rowOf(0)[0].cell.x).toBeCloseTo(0.78 * pitch, 0);
    expect(rowOf(3)[0].cell.x).toBe(rowOf(0)[0].cell.x);
  });

  it('puts the caps on a square pitch, row to row, under a taller number row of cells', () => {
    const tops = [0, 1, 2, 3].map((r) => rowOf(r)[0].cap.y);
    for (let r = 1; r < 4; r++) expect(tops[r] - tops[r - 1]).toBe(49);
    // The number row's cells are taller, to hold the colour names and commands above its keys.
    expect(rowOf(0)[0].cell.height).toBeGreaterThan(rowOf(1)[0].cell.height);
    expect(rowOf(0)[0].above.height).toBeGreaterThan(rowOf(1)[0].above.height);
  });

  it('shares one right edge between ENTER and the right-hand CAPS SHIFT', () => {
    const enter = rowOf(2)[9].cell, caps = rowOf(3)[10].cell;
    expect(enter.x + enter.width).toBeCloseTo(caps.x + caps.width, 0);
  });

  it('makes ENTER and CAPS SHIFT wider than the letter keys, and the space bar widest', () => {
    const letter = rowOf(1)[0].cap.width;
    const enter = rowOf(2)[9].cap.width;
    const caps = rowOf(3)[0].cap.width;
    const space = rowOf(4)[0].cap.width;
    expect(caps).toBeGreaterThan(letter);
    expect(enter).toBeGreaterThan(caps);
    expect(space).toBeGreaterThan(enter * 3);
    expect(rowOf(3)[0].cap.width).toBe(rowOf(3)[10].cap.width);
  });

  it('centres the space bar under the letters, spanning the keys from Z to BREAK', () => {
    const space = rowOf(4)[0].cap;
    const z = rowOf(3)[1].cell, breakKey = rowOf(3)[9].cell;
    expect(space.x).toBeGreaterThan(z.x);
    expect(space.x + space.width).toBeLessThan(breakKey.x + breakKey.width);
    expect(rowOf(4)[0].cell.x + rowOf(4)[0].cell.width).toBe(breakKey.x);
  });

  it('never overlaps two cells in a row', () => {
    for (let r = 0; r < 5; r++) {
      const cells = rowOf(r).map((p) => p.cell);
      for (let i = 1; i < cells.length; i++) expect(cells[i].x).toBeCloseTo(cells[i - 1].x + cells[i - 1].width, 6);
    }
  });
});
