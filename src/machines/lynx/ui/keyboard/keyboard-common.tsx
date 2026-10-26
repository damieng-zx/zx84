/**
 * Camputers Lynx on-screen keyboard interaction and live highlighting.
 *
 * Ten lines of six or seven sense bits, active low (see `lynx-keyboard.ts`).
 *
 * A cap may carry no cell at all: BREAK is wired to the CPU's interrupt line
 * rather than into the matrix, so it depresses under the pointer and reaches
 * no switch. Both SHIFT caps are one switch, so pressing either lights both —
 * which is what the hardware does.
 */

import { createSignal } from 'solid-js';
import { createMatrixKeyboard } from '@/ui/components/matrix-keyboard.ts';
import { activeLynx } from '@/machines/lynx/ui/active.ts';
import type { LynxCell } from './layout.ts';

export interface LynxKeyboardController {
  isDown(id: string, cell: LynxCell | null): boolean;
  onDown(id: string, cell: LynxCell | null): void;
  onUp(id: string, cell: LynxCell | null): void;
}

export function useLynxKeyboard(): LynxKeyboardController {
  const matrix = createMatrixKeyboard({
    keyboard: () => activeLynx()?.keyboard ?? null,
    rows: (kb) => kb.rows,
    setCell: (kb, line, bit, down) => kb.setKey(line, bit, down),
    rowCount: 10,
    released: 0xff,
  });
  /** Caps with no matrix cell, held down for the look of the thing. */
  const [inert, setInert] = createSignal<ReadonlySet<string>>(new Set());

  const isDown = (id: string, cell: LynxCell | null) =>
    cell ? matrix.isDown(cell[0], cell[1]) : inert().has(id);

  const setInertKey = (id: string, down: boolean) => {
    const current = inert();
    if (current.has(id) === down) return;
    const next = new Set(current);
    if (down) next.add(id);
    else next.delete(id);
    setInert(next);
  };

  const onDown = (id: string, cell: LynxCell | null) => {
    if (!cell) setInertKey(id, true);
    else matrix.press(cell[0], cell[1]);
  };

  const onUp = (id: string, cell: LynxCell | null) => {
    if (!cell) setInertKey(id, false);
    else matrix.release(cell[0], cell[1]);
  };

  return { isDown, onDown, onUp };
}
