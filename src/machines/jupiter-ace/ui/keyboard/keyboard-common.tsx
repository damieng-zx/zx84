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

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeAce } from '@/machines/jupiter-ace/ui/active.ts';
import type { Cell } from './legends.ts';

const released = (): number[] => [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

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
  const [matrix, setMatrix] = createSignal<number[]>(released());
  const [latched, setLatched] = createSignal<readonly Cell[]>([]);

  const keyboard = () => activeAce()?.keyboard ?? null;

  const isDown = (pos: Cell) => (matrix()[pos[0]] & (1 << pos[1])) === 0;

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

  // Per-frame poll: mirror the live matrix so physical keystrokes highlight the
  // on-screen keys too, not just pointer presses.
  onMount(() => {
    let raf = 0;
    const tick = () => {
      const kb = keyboard();
      if (kb) {
        const rows = kb.rows;
        const cur = matrix();
        let changed = false;
        for (let i = 0; i < 8; i++) if (rows[i] !== cur[i]) { changed = true; break; }
        if (changed) setMatrix(Array.from(rows));
      } else if (matrix().some((b) => b !== 0xff)) {
        setMatrix(released());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  // A latched modifier must not stay held in the matrix once the pane is gone.
  onCleanup(releaseLatched);

  return { isDown, onDown, onUp };
}
