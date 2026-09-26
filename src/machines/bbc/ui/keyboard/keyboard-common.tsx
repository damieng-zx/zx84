/**
 * BBC Micro on-screen keyboard interaction and live highlighting.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeBbc } from '../active.ts';
import { BBC_KEYS, type BbcKeyDef } from './layout.ts';

const cellId = (column: number, row: number): number => (column << 3) | row;

export interface BbcKeyboardController {
  isDown(key: BbcKeyDef): boolean;
  onDown(key: BbcKeyDef): void;
  onUp(key: BbcKeyDef): void;
}

export function useBbcKeyboard(): BbcKeyboardController {
  const [pressed, setPressed] = createSignal<ReadonlySet<number>>(new Set());
  const held = new Set<number>();
  const keyboard = () => activeBbc()?.keyboard ?? null;

  const isDown = (key: BbcKeyDef): boolean =>
    key.cell ? pressed().has(cellId(key.cell[0], key.cell[1])) : false;

  const onDown = (key: BbcKeyDef): void => {
    const kb = keyboard();
    if (!kb || !key.cell) return;
    const id = cellId(key.cell[0], key.cell[1]);
    if (held.has(id)) return;
    held.add(id);
    kb.setCell(key.cell[0], key.cell[1], true);
  };

  const onUp = (key: BbcKeyDef): void => {
    const kb = keyboard();
    if (!key.cell) return;
    const id = cellId(key.cell[0], key.cell[1]);
    if (!held.delete(id) || !kb) return;
    kb.setCell(key.cell[0], key.cell[1], false);
  };

  onMount(() => {
    let raf = 0;
    const tick = () => {
      const kb = keyboard();
      const next = new Set<number>();
      if (kb) {
        for (const key of BBC_KEYS) {
          if (key.cell && kb.isPressed(key.cell[0], key.cell[1])) {
            next.add(cellId(key.cell[0], key.cell[1]));
          }
        }
      }
      const prev = pressed();
      let changed = prev.size !== next.size;
      if (!changed) for (const v of next) if (!prev.has(v)) { changed = true; break; }
      if (changed) setPressed(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      const kb = keyboard();
      if (kb) for (const id of held) kb.setCell(id >> 3, id & 7, false);
      held.clear();
    });
  });

  return { isDown, onDown, onUp };
}
