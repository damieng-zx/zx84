/**
 * Memotech MTX on-screen keyboard interaction and live highlighting.
 *
 * Eight drive lines of ten sense bits, active low (see `mtx-keyboard.ts`).
 */

import { createMatrixKeyboard } from '@/ui/components/matrix-keyboard.ts';
import { activeMtx } from '@/machines/mtx/ui/active.ts';
import type { MtxCell } from './layout.ts';

export interface MtxKeyboardController {
  isDown(cell: MtxCell): boolean;
  onDown(cell: MtxCell): void;
  onUp(cell: MtxCell): void;
}

export function useMtxKeyboard(): MtxKeyboardController {
  const matrix = createMatrixKeyboard({
    keyboard: () => activeMtx()?.keyboard ?? null,
    rows: (kb) => kb.rows,
    setCell: (kb, drive, sense, down) => kb.setKey(drive, sense, down),
    rowCount: 8,
    released: 0x3ff,
  });

  return {
    isDown: ([drive, sense]) => matrix.isDown(drive, sense),
    onDown: ([drive, sense]) => matrix.press(drive, sense),
    onUp: ([drive, sense]) => matrix.release(drive, sense),
  };
}
