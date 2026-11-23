/**
 * Oric on-screen keyboard interaction and live highlighting.
 *
 * The matrix is eight row bytes read on VIA port B, active high (`rows`), with
 * the column selected through the PSG's port A. Every cap on the Atmos deck has
 * a matrix cell, so the inert path below exists only for a model that grows a
 * cap with no cell. SHIFT is a cell of its own, so pressing either SHIFT cap
 * lights both, which is what the hardware does.
 */

import { createSignal } from 'solid-js';
import { createMatrixKeyboard } from '@/ui/components/matrix-keyboard.ts';
import { activeOric } from '@/machines/oric/ui/active.ts';
import type { OricKeyDef } from './layout.ts';

export interface OricKeyboardController {
  isDown(key: OricKeyDef): boolean;
  onDown(key: OricKeyDef): void;
  onUp(key: OricKeyDef): void;
}

/** The cap is a matrix cell (SHIFT and CTRL have their own cells too). */
function hasCell(key: OricKeyDef): boolean {
  return key.row >= 0 && key.col >= 0;
}

export function useOricKeyboard(): OricKeyboardController {
  const matrix = createMatrixKeyboard({
    keyboard: () => activeOric()?.keyboard ?? null,
    rows: (kb) => kb.rows,
    setCell: (kb, row, col, down) => kb.setCell(row, col, down),
    rowCount: 8,
    // `rows` is active high: bit set means pressed.
    released: 0,
    activeLow: false,
  });

  /** Caps with no matrix cell, held down under the pointer. */
  const [inert, setInert] = createSignal<ReadonlySet<string>>(new Set());

  const setInertKey = (id: string, down: boolean): void => {
    const current = inert();
    if (current.has(id) === down) return;
    const next = new Set(current);
    if (down) next.add(id);
    else next.delete(id);
    setInert(next);
  };

  const isDown = (key: OricKeyDef): boolean =>
    hasCell(key) ? matrix.isDown(key.row, key.col) : inert().has(key.id);

  const onDown = (key: OricKeyDef): void => {
    if (hasCell(key)) matrix.press(key.row, key.col);
    else setInertKey(key.id, true);
  };

  const onUp = (key: OricKeyDef): void => {
    if (hasCell(key)) matrix.release(key.row, key.col);
    else setInertKey(key.id, false);
  };

  return { isDown, onDown, onUp };
}
