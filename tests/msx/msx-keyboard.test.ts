/**
 * MsxKeyboard — MSX International matrix scan.
 *
 * Cell positions are taken from the authoritative MSX International keyboard
 * matrix (map.grauw.nl/articles/keymatrix.php), independent of the source: A=[2,6],
 * B=[2,7], S=[5,0], digit 2=[0,2], SHIFT=[6,0], SPACE=[8,0]. Reads are active-low
 * (a pressed key clears its column bit); only the selected row is visible.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MsxKeyboard } from '@/machines/msx/msx-keyboard.ts';

/** Expected active-low byte for a single pressed bit on an otherwise idle row. */
const oneDown = (bit: number) => (0xFF & ~(1 << bit)) & 0xFF;

describe('MsxKeyboard matrix', () => {
  let kbd: MsxKeyboard;
  beforeEach(() => { kbd = new MsxKeyboard(); });

  it('reads all-released as 0xFF on every row', () => {
    for (let row = 0; row < 11; row++) {
      kbd.selectRow(row);
      expect(kbd.readColumns()).toBe(0xFF);
    }
  });

  it('reports a pressed key at its [row, bit] active-low', () => {
    kbd.handleKeyEvent('KeyA', true);   // A = row 2, bit 6
    kbd.selectRow(2);
    expect(kbd.readColumns()).toBe(oneDown(6));   // 0xBF
  });

  it('shows a key only on its own row', () => {
    kbd.handleKeyEvent('KeyA', true);   // row 2
    kbd.selectRow(3);
    expect(kbd.readColumns()).toBe(0xFF);          // nothing on row 3
    kbd.selectRow(2);
    expect(kbd.readColumns()).toBe(oneDown(6));
  });

  it('ANDs multiple keys pressed on the same row', () => {
    kbd.handleKeyEvent('KeyA', true);   // [2,6]
    kbd.handleKeyEvent('KeyB', true);   // [2,7]
    kbd.selectRow(2);
    expect(kbd.readColumns()).toBe((0xFF & ~((1 << 6) | (1 << 7))) & 0xFF); // 0x3F
  });

  it('maps digits, SHIFT and SPACE to their documented cells', () => {
    kbd.handleKeyEvent('Digit2', true);   // [0,2]
    kbd.handleKeyEvent('ShiftLeft', true); // [6,0]
    kbd.handleKeyEvent('Space', true);    // [8,0]
    kbd.selectRow(0); expect(kbd.readColumns()).toBe(oneDown(2)); // 0xFB
    kbd.selectRow(6); expect(kbd.readColumns()).toBe(oneDown(0)); // 0xFE
    kbd.selectRow(8); expect(kbd.readColumns()).toBe(oneDown(0)); // 0xFE
  });

  it('releases a key on keyup', () => {
    kbd.handleKeyEvent('KeyS', true);   // [5,0]
    kbd.selectRow(5);
    expect(kbd.readColumns()).toBe(oneDown(0));
    kbd.handleKeyEvent('KeyS', false);
    expect(kbd.readColumns()).toBe(0xFF);
  });

  it('returns false for an unmapped code and 0xFF for out-of-range rows', () => {
    expect(kbd.handleKeyEvent('MediaPlayPause', true)).toBe(false);
    kbd.selectRow(15);                    // rows 11–15 have no keys
    expect(kbd.readColumns()).toBe(0xFF);
  });

  it('reset clears all held keys', () => {
    kbd.handleKeyEvent('KeyA', true);
    kbd.reset();
    kbd.selectRow(2);
    expect(kbd.readColumns()).toBe(0xFF);
  });
});
