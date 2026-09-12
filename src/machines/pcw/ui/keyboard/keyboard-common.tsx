/**
 * PCW on-screen keyboard interaction and live highlighting.
 *
 * The PCW's keyboard is not a port to be read: the gate array DMAs sixteen
 * bytes into memory and software reads them there, so "press a key" here means
 * "set that bit in the matrix" and nothing else. `PcwKeyboard.setCell` keeps
 * the pointer's presses in their own set, so a cap pressed here and the same
 * cap pressed on the host keyboard cannot release each other.
 *
 * Both SHIFT caps are one switch, so pressing either lights both — which is
 * what the hardware does. SHIFT LOCK latches rather than staying down, so it
 * is shown lit from the keyboard's own lock state rather than from the matrix.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activePcw } from '@/machines/pcw/ui/active.ts';
import type { PcwCell } from '@/machines/pcw/pcw-keyboard.ts';

/** The eleven key bytes; the rest are links and flags. */
const KEY_BYTES = 0x0B;

const released = (): number[] => new Array<number>(KEY_BYTES).fill(0);

export interface PcwKeyboardController {
  isDown(id: string, cell: PcwCell): boolean;
  onDown(cell: PcwCell): void;
  onUp(cell: PcwCell): void;
}

/** SHIFT LOCK's cell — shown from the lock state, not from the bit. */
const SHIFT_LOCK_ID = 'shift-lock';

export function usePcwKeyboard(): PcwKeyboardController {
  const [matrix, setMatrix] = createSignal<number[]>(released());
  const [locked, setLocked] = createSignal(false);
  const held = new Set<string>();
  const keyboard = () => activePcw()?.keyboard ?? null;
  const idOf = ([byte, bit]: PcwCell) => `${byte},${bit}`;

  const isDown = (id: string, cell: PcwCell) =>
    id === SHIFT_LOCK_ID ? locked() : (matrix()[cell[0]] & (1 << cell[1])) !== 0;

  const onDown = (cell: PcwCell) => {
    const kb = keyboard();
    if (!kb) return;
    const cellId = idOf(cell);
    if (held.has(cellId)) return;
    held.add(cellId);
    kb.setCell(cell, true);
  };

  const onUp = (cell: PcwCell) => {
    const kb = keyboard();
    const cellId = idOf(cell);
    if (!held.delete(cellId) || !kb) return;
    kb.setCell(cell, false);
  };

  onMount(() => {
    let raf = 0;
    const tick = () => {
      const kb = keyboard();
      if (kb) {
        const bytes = kb.matrix;
        const current = matrix();
        let changed = false;
        for (let index = 0; index < KEY_BYTES; index++) {
          if (bytes[index] !== current[index]) { changed = true; break; }
        }
        if (changed) setMatrix(Array.from(bytes.subarray(0, KEY_BYTES)));
        if (kb.shiftLock !== locked()) setLocked(kb.shiftLock);
      } else if (matrix().some((value) => value !== 0)) {
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
          const [byte, bit] = cellId.split(',').map(Number);
          kb.setCell([byte, bit], false);
        }
      }
      held.clear();
    });
  });

  return { isDown, onDown, onUp };
}
