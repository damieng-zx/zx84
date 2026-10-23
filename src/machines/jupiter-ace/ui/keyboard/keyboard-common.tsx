/**
 * Interaction plumbing for the Jupiter Ace on-screen keyboard.
 *
 * `useKeyboard()` drives the live `AceKeyboard` matrix and mirrors it back for
 * highlighting. The Ace has two modifiers — SHIFT and SYMBOL SHIFT — and each
 * latches one-shot: held until the next ordinary key is released, or clicked
 * again to unlatch. Unlike the Spectrum there is no SHIFT + SYMBOL SHIFT chord
 * (no extended mode), so a second modifier simply latches alongside the first.
 * (`AceKeyboard.setKey` reference-counts each bit, so a latched modifier and a
 * physical one coexist without desyncing.)
 */

import { createSignal, onCleanup } from 'solid-js';
import { createMatrixKeyboard } from '@/ui/components/matrix-keyboard.ts';
import { activeAce } from '@/machines/jupiter-ace/ui/active.ts';
import type { Cell } from './legends.ts';

const sameCell = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1];

export interface KeyboardController {
  /** True when this key's matrix bit is currently held (active-low). */
  isDown(pos: Cell): boolean;
  /** Press an ordinary key, or toggle a modifier latch. */
  onDown(pos: Cell, latch?: boolean): void;
  /** Release an ordinary key (and clear any latched modifiers). */
  onUp(pos: Cell, latch?: boolean): void;
}

export function useKeyboard(): KeyboardController {
  const [latched, setLatched] = createSignal<readonly Cell[]>([]);

  const keyboard = () => activeAce()?.keyboard ?? null;

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

  const releaseLatched = () => {
    const kb = keyboard();
    if (kb) for (const [row, bit] of latched()) kb.setKey(row, bit, false);
    setLatched([]);
  };

  const onDown = (pos: Cell, latch?: boolean) => {
    const kb = keyboard();
    if (!kb) return;
    if (!latch) {
      kb.setKey(pos[0], pos[1], true);
      return;
    }
    // Click a modifier to latch it, click again to unlatch.
    const cur = latched();
    if (cur.some((c) => sameCell(c, pos))) {
      kb.setKey(pos[0], pos[1], false);
      setLatched(cur.filter((c) => !sameCell(c, pos)));
    } else {
      kb.setKey(pos[0], pos[1], true);
      setLatched([...cur, pos]);
    }
  };

  const onUp = (pos: Cell, latch?: boolean) => {
    const kb = keyboard();
    if (!kb || latch) return; // modifiers toggle on press only
    kb.setKey(pos[0], pos[1], false);
    // One-shot: drop latched modifiers once an ordinary key has been used.
    if (latched().length > 0) releaseLatched();
  };

  // A latched modifier must not stay held in the matrix once the pane is gone.
  onCleanup(releaseLatched);

  return { isDown, onDown, onUp };
}
