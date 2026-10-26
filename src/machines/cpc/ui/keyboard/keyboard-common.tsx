/**
 * CPC 464 on-screen keyboard interaction and live highlighting.
 */

import { createMatrixKeyboard } from '@/ui/components/matrix-keyboard.ts';
import { activeCpc } from '@/machines/cpc/ui/active.ts';
import type { CpcCell } from './layout.ts';

export interface CpcKeyboardController {
  isDown(cell: CpcCell): boolean;
  onDown(cell: CpcCell): void;
  onUp(cell: CpcCell): void;
}

export function useCpcKeyboard(): CpcKeyboardController {
  const matrix = createMatrixKeyboard({
    keyboard: () => activeCpc()?.keyboard ?? null,
    rows: (kb) => kb.rows,
    setCell: (kb, line, bit, down) => kb.setKey(line, bit, down),
    rowCount: 10,
    released: 0xff,
  });

  return {
    isDown: ([line, bit]) => matrix.isDown(line, bit),
    onDown: ([line, bit]) => matrix.press(line, bit),
    onUp: ([line, bit]) => matrix.release(line, bit),
  };
}
