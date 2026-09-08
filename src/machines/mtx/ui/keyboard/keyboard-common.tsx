/**
 * Memotech MTX on-screen keyboard interaction and live highlighting.
 *
 * Eight drive lines of ten sense bits, active low (see `mtx-keyboard.ts`).
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeMtx } from '@/machines/mtx/ui/active.ts';
import type { MtxCell } from './layout.ts';

const released = (): number[] =>
  [0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x3ff];

export interface MtxKeyboardController {
  isDown(cell: MtxCell): boolean;
  onDown(cell: MtxCell): void;
  onUp(cell: MtxCell): void;
}

export function useMtxKeyboard(): MtxKeyboardController {
  const [matrix, setMatrix] = createSignal<number[]>(released());
  const held = new Set<string>();
  const keyboard = () => activeMtx()?.keyboard ?? null;
  const idOf = ([drive, sense]: MtxCell) => `${drive},${sense}`;

  const isDown = ([drive, sense]: MtxCell) =>
    (matrix()[drive] & (1 << sense)) === 0;

  const onDown = (cell: MtxCell) => {
    const kb = keyboard();
    if (!kb) return;
    const id = idOf(cell);
    if (held.has(id)) return;
    held.add(id);
    kb.setKey(cell[0], cell[1], true);
  };

  const onUp = (cell: MtxCell) => {
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
      } else if (matrix().some((value) => value !== 0x3ff)) {
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
          const [drive, sense] = id.split(',').map(Number);
          kb.setKey(drive, sense, false);
        }
      }
      held.clear();
    });
  });

  return { isDown, onDown, onUp };
}
