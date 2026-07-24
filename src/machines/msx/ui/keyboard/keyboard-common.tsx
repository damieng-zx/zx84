/**
 * Toshiba HX-10 on-screen keyboard interaction and live highlighting.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeMsx } from '@/machines/msx/ui/active.ts';
import type { Hx10Cell } from './layout.ts';

const released = (): number[] =>
  [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

export interface Hx10KeyboardController {
  isDown(cell: Hx10Cell): boolean;
  onDown(cell: Hx10Cell): void;
  onUp(cell: Hx10Cell): void;
}

export function useHx10Keyboard(): Hx10KeyboardController {
  const [matrix, setMatrix] = createSignal<number[]>(released());
  const held = new Set<string>();
  const keyboard = () => activeMsx()?.keyboard ?? null;
  const idOf = ([row, bit]: Hx10Cell) => `${row},${bit}`;

  const isDown = ([row, bit]: Hx10Cell) =>
    (matrix()[row] & (1 << bit)) === 0;

  const onDown = (cell: Hx10Cell) => {
    const kb = keyboard();
    if (!kb) return;
    const id = idOf(cell);
    if (held.has(id)) return;
    held.add(id);
    kb.setKey(cell[0], cell[1], true);
  };

  const onUp = (cell: Hx10Cell) => {
    const kb = keyboard();
    const id = idOf(cell);
    if (!held.delete(id) || !kb) return;
    kb.setKey(cell[0], cell[1], false);
  };

  onMount(() => {
    let raf = 0;
    const tick = () => {
      const kb = keyboard();
      if (kb) {
        const rows = kb.rows;
        const current = matrix();
        let changed = false;
        for (let index = 0; index < rows.length; index++) {
          if (rows[index] !== current[index]) {
            changed = true;
            break;
          }
        }
        if (changed) setMatrix(Array.from(rows));
      } else if (matrix().some((value) => value !== 0xff)) {
        setMatrix(released());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => {
      cancelAnimationFrame(raf);
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
