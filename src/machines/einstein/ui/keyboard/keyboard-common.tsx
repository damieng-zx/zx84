/**
 * Tatung Einstein on-screen keyboard interaction and live highlighting,
 * shared by the TC-01 and 256 faces.
 *
 * Nine rows, not eight: the ninth is the keyboard's synthetic status line,
 * which carries SHIFT / CONTROL / GRAPH (see `einstein-keyboard.ts`).
 *
 * A cap presses a *chord* rather than a single cell, because not every printed
 * key is one switch: the TC-01's twin-arrow cursor caps reach their upper
 * legend through SHIFT, and the 256's cursor-up wedge through CONTROL.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeEinstein } from '@/machines/einstein/ui/active.ts';
import type { EinsteinCell } from './layout.ts';

const released = (): number[] =>
  [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

export interface EinsteinKeyboardController {
  isDown(chord: readonly EinsteinCell[]): boolean;
  onDown(chord: readonly EinsteinCell[]): void;
  onUp(chord: readonly EinsteinCell[]): void;
}

export function useEinsteinKeyboard(): EinsteinKeyboardController {
  const [matrix, setMatrix] = createSignal<number[]>(released());
  const held = new Set<string>();
  const keyboard = () => activeEinstein()?.keyboard ?? null;
  const idOf = ([line, bit]: EinsteinCell) => `${line},${bit}`;

  const isDown = (chord: readonly EinsteinCell[]) =>
    chord.every(([line, bit]) => (matrix()[line] & (1 << bit)) === 0);

  const onDown = (chord: readonly EinsteinCell[]) => {
    const kb = keyboard();
    if (!kb) return;
    for (const cell of chord) {
      const id = idOf(cell);
      if (held.has(id)) continue;
      held.add(id);
      kb.setKey(cell[0], cell[1], true);
    }
  };

  const onUp = (chord: readonly EinsteinCell[]) => {
    const kb = keyboard();
    for (const cell of chord) {
      if (!held.delete(idOf(cell)) || !kb) continue;
      kb.setKey(cell[0], cell[1], false);
    }
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
