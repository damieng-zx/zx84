/**
 * Interaction plumbing for the ZX81 / ZX80 on-screen keyboard.
 *
 * `useKeyboard()` drives the live `Zx8xKeyboard` matrix and mirrors it back for
 * highlighting. The ZX8x has a single modifier — SHIFT — which latches one-shot:
 * held until the next ordinary key is released, or clicked again to unlatch.
 * (The matrix bits are reference-counted in `Zx8xKeyboard.setKey`, so a latched
 * SHIFT and a physical Shift coexist without desyncing.)
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeZx8x } from '@/machines/zx8x/ui/active.ts';
import { SHIFT, type Cell } from './legends.ts';

const released = (): number[] => [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

export interface KeyboardController {
  /** True when this key's matrix bit is currently held (active-low). */
  isDown(pos: Cell): boolean;
  /** Press an ordinary key, or toggle the SHIFT latch. */
  onDown(pos: Cell, latch?: boolean): void;
  /** Release an ordinary key (and clear a one-shot SHIFT latch). */
  onUp(pos: Cell, latch?: boolean): void;
}

export function useKeyboard(): KeyboardController {
  const [matrix, setMatrix] = createSignal<number[]>(released());
  const [shiftLatched, setShiftLatched] = createSignal(false);

  const keyboard = () => activeZx8x()?.keyboard ?? null;

  const isDown = (pos: Cell) => (matrix()[pos[0]] & (1 << pos[1])) === 0;

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

  return { isDown, onDown, onUp };
}
