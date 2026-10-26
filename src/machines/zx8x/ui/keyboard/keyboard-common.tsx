/**
 * Interaction plumbing for the ZX81 / ZX80 on-screen keyboard.
 *
 * `useKeyboard()` drives the live `Zx8xKeyboard` matrix and mirrors it back for
 * highlighting. The ZX8x has a single modifier — SHIFT — which latches one-shot:
 * held until the next ordinary key is released, or clicked again to unlatch.
 * (The matrix bits are reference-counted in `Zx8xKeyboard.setKey`, so a latched
 * SHIFT and a physical Shift coexist without desyncing.)
 */

import { createSignal } from 'solid-js';
import { createMatrixKeyboard } from '@/ui/components/matrix-keyboard.ts';
import { activeZx8x } from '@/machines/zx8x/ui/active.ts';
import { SHIFT, type Cell } from './legends.ts';

export interface KeyboardController {
  /** True when this key's matrix bit is currently held (active-low). */
  isDown(pos: Cell): boolean;
  /** Press an ordinary key, or toggle the SHIFT latch. */
  onDown(pos: Cell, latch?: boolean): void;
  /** Release an ordinary key (and clear a one-shot SHIFT latch). */
  onUp(pos: Cell, latch?: boolean): void;
}

export function useKeyboard(): KeyboardController {
  const [shiftLatched, setShiftLatched] = createSignal(false);

  const keyboard = () => activeZx8x()?.keyboard ?? null;

  // Mirrors the live matrix each frame so physical keystrokes highlight the
  // on-screen keys too, not just pointer presses.
  const matrix = createMatrixKeyboard({
    keyboard,
    rows: (kb) => kb.rows,
    setCell: (kb, row, bit, down) => kb.setKey(row, bit, down),
    rowCount: 8,
    released: 0xff,
  });
  const isDown = (pos: Cell) => matrix.isDown(pos[0], pos[1]);

  const onDown = (pos: Cell, latch?: boolean) => {
    const kb = keyboard();
    if (!kb) return;
    if (latch) {
      // Click SHIFT to latch it, click again to unlatch.
      const next = !shiftLatched();
      kb.setKey(pos[0], pos[1], next);
      setShiftLatched(next);
      return;
    }
    kb.setKey(pos[0], pos[1], true);
  };

  const onUp = (pos: Cell, latch?: boolean) => {
    const kb = keyboard();
    if (!kb || latch) return; // SHIFT toggles on press only
    kb.setKey(pos[0], pos[1], false);
    // One-shot: drop a latched SHIFT once an ordinary key has been used.
    if (shiftLatched()) {
      kb.setKey(SHIFT[0], SHIFT[1], false);
      setShiftLatched(false);
    }
  };

  return { isDown, onDown, onUp };
}
