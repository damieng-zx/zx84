/**
 * Camputers Lynx on-screen keyboard interaction and live highlighting.
 *
 * Ten lines of six or seven sense bits, active low (see `lynx-keyboard.ts`).
 *
 * A cap may carry no cell at all: BREAK is wired to the CPU's interrupt line
 * rather than into the matrix, so it depresses under the pointer and reaches
 * no switch. Both SHIFT caps are one switch, so pressing either lights both —
 * which is what the hardware does.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeLynx } from '@/machines/lynx/ui/active.ts';
import type { LynxCell } from './layout.ts';

const LINES = 10;

const released = (): number[] => new Array<number>(LINES).fill(0xff);

export interface LynxKeyboardController {
  isDown(id: string, cell: LynxCell | null): boolean;
  onDown(id: string, cell: LynxCell | null): void;
  onUp(id: string, cell: LynxCell | null): void;
}

export function useLynxKeyboard(): LynxKeyboardController {
  const [matrix, setMatrix] = createSignal<number[]>(released());
  /** Caps with no matrix cell, held down for the look of the thing. */
  const [inert, setInert] = createSignal<ReadonlySet<string>>(new Set());
  const held = new Set<string>();
  const keyboard = () => activeLynx()?.keyboard ?? null;
  const idOf = ([line, bit]: LynxCell) => `${line},${bit}`;

  const isDown = (id: string, cell: LynxCell | null) =>
    cell ? (matrix()[cell[0]] & (1 << cell[1])) === 0 : inert().has(id);

  const setInertKey = (id: string, down: boolean) => {
    const current = inert();
    if (current.has(id) === down) return;
    const next = new Set(current);
    if (down) next.add(id);
    else next.delete(id);
    setInert(next);
  };

  const onDown = (id: string, cell: LynxCell | null) => {
    if (!cell) { setInertKey(id, true); return; }
    const kb = keyboard();
    if (!kb) return;
    const cellId = idOf(cell);
    if (held.has(cellId)) return;
    held.add(cellId);
    kb.setKey(cell[0], cell[1], true);
  };

  const onUp = (id: string, cell: LynxCell | null) => {
    if (!cell) { setInertKey(id, false); return; }
    const kb = keyboard();
    const cellId = idOf(cell);
    if (!held.delete(cellId) || !kb) return;
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
        for (const cellId of held) {
          const [line, bit] = cellId.split(',').map(Number);
          kb.setKey(line, bit, false);
        }
      }
      held.clear();
    });
  });

  return { isDown, onDown, onUp };
}
