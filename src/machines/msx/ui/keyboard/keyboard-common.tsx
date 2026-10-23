/**
 * Toshiba HX-10 on-screen keyboard interaction and live highlighting.
 */

import { createMatrixKeyboard } from '@/ui/components/matrix-keyboard.ts';
import { activeMsx } from '@/machines/msx/ui/active.ts';
import type { Hx10Cell } from './layout.ts';

export interface Hx10KeyboardController {
  isDown(cell: Hx10Cell): boolean;
  onDown(cell: Hx10Cell): void;
  onUp(cell: Hx10Cell): void;
}

export function useHx10Keyboard(): Hx10KeyboardController {
  const matrix = createMatrixKeyboard({
    keyboard: () => activeMsx()?.keyboard ?? null,
    rows: (kb) => kb.rows,
    setCell: (kb, row, bit, down) => kb.setKey(row, bit, down),
    rowCount: 11,
    released: 0xff,
  });

  return {
    isDown: ([row, bit]) => matrix.isDown(row, bit),
    onDown: ([row, bit]) => matrix.press(row, bit),
    onUp: ([row, bit]) => matrix.release(row, bit),
  };
}
