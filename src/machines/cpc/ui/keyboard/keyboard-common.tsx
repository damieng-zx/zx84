/**
 * CPC 464 on-screen keyboard interaction and live highlighting.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeCpc } from '@/machines/cpc/ui/active.ts';
import type { CpcCell } from './layout.ts';

const released = (): number[] =>
  [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

export interface CpcKeyboardController {
  isDown(cell: CpcCell): boolean;
  onDown(cell: CpcCell): void;
  onUp(cell: CpcCell): void;
}

export function useCpcKeyboard(): CpcKeyboardController {
  const [matrix, setMatrix] = createSignal<number[]>(released());
  const held = new Set<string>();
  const keyboard = () => activeCpc()?.keyboard ?? null;
  const idOf = ([line, bit]: CpcCell) => `${line},${bit}`;

  const isDown = ([line, bit]: CpcCell) =>
    (matrix()[line] & (1 << bit)) === 0;

  const onDown = (cell: CpcCell) => {
    const kb = keyboard();
    if (!kb) return;
    const id = idOf(cell);
    if (held.has(id)) return;
    held.add(id);
    kb.setKey(cell[0], cell[1], true);
  };

  const onUp = (cell: CpcCell) => {
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
        for (let i = 0; i < rows.length; i++) {
          if (rows[i] !== current[i]) {
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
