/**
 * SAM Coupé on-screen keyboard interaction and live highlighting.
 *
 * Presses go straight into the matrix through `SamKeyboard.setKey`, which
 * reference-counts each position — so a cap held with the pointer and the same
 * key held physically both let go independently without desyncing the bit.
 *
 * Two caps share a matrix cell in each of the SHIFT and SYMBOL pairs, exactly
 * as the real machine wires them, so pressing either lights both.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeSam } from '@/machines/sam/ui/active.ts';
import type { SamCell } from './layout.ts';

/** Nine rows, all bits high — nothing held. */
const released = (): number[] => new Array(9).fill(0xFF);

export interface SamKeyboardController {
  isDown(cell: SamCell): boolean;
  onDown(cell: SamCell): void;
  onUp(cell: SamCell): void;
}

export function useSamKeyboard(): SamKeyboardController {
  const [matrix, setMatrix] = createSignal<number[]>(released());
  const held = new Set<string>();
  const keyboard = () => activeSam()?.keyboard ?? null;
  const idOf = ([row, bit]: SamCell) => `${row},${bit}`;

  const isDown = ([row, bit]: SamCell) => (matrix()[row] & (1 << bit)) === 0;

  const onDown = (cell: SamCell) => {
    const kb = keyboard();
    if (!kb) return;
    const id = idOf(cell);
    // A pointer that re-enters a cap it is already holding must not press it
    // twice: the matrix counts holders, and the second release would leave
    // the bit stuck down.
    if (held.has(id)) return;
    held.add(id);
    kb.setKey(cell[0], cell[1], true);
  };

  const onUp = (cell: SamCell) => {
    const kb = keyboard();
    const id = idOf(cell);
    if (!held.delete(id) || !kb) return;
    kb.setKey(cell[0], cell[1], false);
  };

  // Mirror the live matrix each frame, so a physical keystroke lights its cap
  // too rather than only pointer presses.
  onMount(() => {
    let raf = 0;
    const tick = () => {
      const kb = keyboard();
      if (kb) {
        const rows = kb.rows;
        const current = matrix();
        let changed = false;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i] !== current[i]) { changed = true; break; }
        }
        if (changed) setMatrix(Array.from(rows));
      } else if (matrix().some(value => value !== 0xFF)) {
        setMatrix(released());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      // Leaving the pane with a cap held must not strand the bit down.
      const kb = keyboard();
      if (kb) {
        for (const id of held) {
          const [row, bit] = id.split(',').map(Number);
          kb.setKey(row, bit, false);
        }
      }
      held.clear();
    });
  });

  return { isDown, onDown, onUp };
}
