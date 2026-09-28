/**
 * BBC Micro on-screen keyboard interaction and live highlighting.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeBbc } from '../active.ts';
import { BBC_KEYS, type BbcKeyDef } from './layout.ts';

const cellId = (column: number, row: number): number => (column << 3) | row;

export type BbcLed = 'motor' | 'caps' | 'shift';

export interface BbcKeyboardController {
  isDown(key: BbcKeyDef): boolean;
  onDown(key: BbcKeyDef): void;
  onUp(key: BbcKeyDef): void;
  /** Whether an indicator lamp (cassette motor / CAPS LOCK / SHIFT LOCK) is lit. */
  ledOn(led: BbcLed): boolean;
}

export function useBbcKeyboard(): BbcKeyboardController {
  const [pressed, setPressed] = createSignal<ReadonlySet<number>>(new Set());
  const [capsLed, setCapsLed] = createSignal(false);
  const [shiftLed, setShiftLed] = createSignal(false);
  const [motorLed, setMotorLed] = createSignal(false);
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
    // Raise the keyboard interrupt (CA2) as a host key press does — the MOS
    // only scans the matrix after it, so without this clicks go unseen.
    activeBbc()?.keyboardActivity();
  };

  const onUp = (key: BbcKeyDef): void => {
    const kb = keyboard();
    if (!key.cell) return;
    const id = cellId(key.cell[0], key.cell[1]);
    if (!held.delete(id) || !kb) return;
    kb.setCell(key.cell[0], key.cell[1], false);
    activeBbc()?.keyboardActivity();
  };

  onMount(() => {
    let raf = 0;
    const tick = () => {
      const kb = keyboard();
      const bbc = activeBbc();
      setCapsLed(bbc?.ic32.capsLock ?? false);
      setShiftLed(bbc?.ic32.shiftLock ?? false);
      // Serial ULA control bit 7 switches the cassette motor relay (and lamp).
      setMotorLed(((bbc?.serialUlaControl ?? 0) & 0x80) !== 0);
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

  const ledOn = (led: BbcLed): boolean =>
    led === 'caps' ? capsLed() : led === 'shift' ? shiftLed() : motorLed();

  return { isDown, onDown, onUp, ledOn };
}
