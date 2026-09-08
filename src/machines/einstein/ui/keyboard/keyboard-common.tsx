/**
 * Tatung Einstein TC-01 on-screen keyboard interaction and live highlighting.
 *
 * Nine rows, not eight: the ninth is the keyboard's synthetic status line,
 * which carries SHIFT / CONTROL / GRAPH (see `einstein-keyboard.ts`).
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeEinstein } from '@/machines/einstein/ui/active.ts';
import type { Tc01Cell } from './layout.ts';

const released = (): number[] =>
  [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

export interface Tc01KeyboardController {
  isDown(cell: Tc01Cell): boolean;
  onDown(cell: Tc01Cell): void;
  onUp(cell: Tc01Cell): void;
}

export function useTc01Keyboard(): Tc01KeyboardController {
  const [matrix, setMatrix] = createSignal<number[]>(released());
  const held = new Set<string>();
  const keyboard = () => activeEinstein()?.keyboard ?? null;
  const idOf = ([line, bit]: Tc01Cell) => `${line},${bit}`;

  const isDown = ([line, bit]: Tc01Cell) =>
    (matrix()[line] & (1 << bit)) === 0;

  const onDown = (cell: Tc01Cell) => {
    const kb = keyboard();
    if (!kb) return;
    const id = idOf(cell);
    if (held.has(id)) return;
    held.add(id);
    kb.setKey(cell[0], cell[1], true);
  };

  const onUp = (cell: Tc01Cell) => {
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
          const [line, bit] = id.split(',').map(Number);
          kb.setKey(line, bit, false);
        }
      }
      held.clear();
    });
  });

  return { isDown, onDown, onUp };
}
