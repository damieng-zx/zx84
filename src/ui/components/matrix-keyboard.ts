/**
 * The part of an on-screen keyboard that is the same on every matrix machine: a
 * per-frame mirror of the live key matrix (so physical keystrokes light the caps
 * too, not just pointer presses) and the set of cells the pointer is holding.
 *
 * What differs per machine — chords, latched modifiers, LEDs, cell types — stays
 * in the machine's own `keyboard-common.tsx`, which wraps this. Call it from a
 * component's setup, like any Solid hook.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';

export interface MatrixKeyboardOptions<K> {
  /** The live keyboard, or null while another machine is running. */
  keyboard: () => K | null;
  /** The keyboard's live row bytes. */
  rows: (kb: K) => ArrayLike<number>;
  /** Press or release one matrix cell. */
  setCell: (kb: K, line: number, bit: number, down: boolean) => void;
  /** How many rows are mirrored. */
  rowCount: number;
  /** What a row reads when nothing is pressed (0xff, 0x3ff, … active-low; 0 active-high). */
  released: number;
  /** True when a pressed key reads as a clear bit (the default). */
  activeLow?: boolean;
  /** Extra per-frame work (LEDs, latches), run after the matrix is mirrored. */
  onFrame?: (kb: K | null) => void;
}

export interface MatrixKeyboard {
  /** True when the cell's bit currently reads as pressed. */
  isDown(line: number, bit: number): boolean;
  /** Press a cell, remembering it so it is released when the pane goes away. A held cell is not pressed twice. */
  press(line: number, bit: number): void;
  /** Release a cell pressed with `press`. A cell that is not held is left alone. */
  release(line: number, bit: number): void;
}

export function createMatrixKeyboard<K>(options: MatrixKeyboardOptions<K>): MatrixKeyboard {
  const { keyboard, rows, setCell, rowCount, released, onFrame } = options;
  const activeLow = options.activeLow ?? true;
  const releasedRows = (): number[] => new Array<number>(rowCount).fill(released);
  const [matrix, setMatrix] = createSignal<number[]>(releasedRows());
  const held = new Set<string>();

  const isDown = (line: number, bit: number): boolean =>
    (((matrix()[line] >> bit) & 1) === 0) === activeLow;

  const press = (line: number, bit: number): void => {
    const kb = keyboard();
    if (!kb) return;
    const id = `${line},${bit}`;
    if (held.has(id)) return;
    held.add(id);
    setCell(kb, line, bit, true);
  };

  const release = (line: number, bit: number): void => {
    const kb = keyboard();
    if (!held.delete(`${line},${bit}`) || !kb) return;
    setCell(kb, line, bit, false);
  };

  onMount(() => {
    let raf = 0;
    const tick = () => {
      const kb = keyboard();
      if (kb) {
        const live = rows(kb);
        const current = matrix();
        let changed = false;
        for (let index = 0; index < rowCount; index++) {
          if (live[index] !== current[index]) {
            changed = true;
            break;
          }
        }
        if (changed) setMatrix(Array.from({ length: rowCount }, (_, index) => live[index]));
      } else if (matrix().some((value) => value !== released)) {
        setMatrix(releasedRows());
      }
      onFrame?.(kb);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      const kb = keyboard();
      if (kb) {
        for (const id of held) {
          const [line, bit] = id.split(',').map(Number);
          setCell(kb, line, bit, false);
        }
      }
      held.clear();
    });
  });

  return { isDown, press, release };
}
