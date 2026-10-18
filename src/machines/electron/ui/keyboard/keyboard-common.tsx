/**
 * Acorn Electron on-screen keyboard interaction and live highlighting.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeElectron } from '../active.ts';
import { ELECTRON_KEYS, type ElectronKeyDef } from './layout.ts';

const cellId = (column: number, row: number): number => (column << 2) | row;

export type ElectronLed = 'motor' | 'caps';

export interface ElectronKeyboardController {
  isDown(key: ElectronKeyDef): boolean;
  onDown(key: ElectronKeyDef): void;
  onUp(key: ElectronKeyDef): void;
  /** Whether an indicator lamp (cassette motor / caps lock) is lit. */
  ledOn(led: ElectronLed): boolean;
}

export function useElectronKeyboard(): ElectronKeyboardController {
  const [pressed, setPressed] = createSignal<ReadonlySet<number>>(new Set());
  const [capsLed, setCapsLed] = createSignal(false);
  const [motorLed, setMotorLed] = createSignal(false);
  const held = new Set<number>();
  const keyboard = () => activeElectron()?.keyboard ?? null;

  const isDown = (key: ElectronKeyDef): boolean =>
    key.cell ? pressed().has(cellId(key.cell[0], key.cell[1])) : false;

  const onDown = (key: ElectronKeyDef): void => {
    const kb = keyboard();
    if (!kb || !key.cell) return;
    const id = cellId(key.cell[0], key.cell[1]);
    if (held.has(id)) return;
    held.add(id);
    kb.setCell(key.cell[0], key.cell[1], true);
  };

  const onUp = (key: ElectronKeyDef): void => {
    const kb = keyboard();
    if (!key.cell) return;
    const id = cellId(key.cell[0], key.cell[1]);
    if (!held.delete(id) || !kb) return;
    kb.setCell(key.cell[0], key.cell[1], false);
  };

  onMount(() => {
    let raf = 0;
    const tick = () => {
      const m = activeElectron();
      const kb = keyboard();
      setCapsLed(m?.ula.capsLock ?? false);
      setMotorLed(m?.ula.cassMotor ?? false);
      const next = new Set<number>();
      if (kb) {
        for (const key of ELECTRON_KEYS) {
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
      if (kb) for (const id of held) kb.setCell(id >> 2, id & 3, false);
      held.clear();
    });
  });

  const ledOn = (led: ElectronLed): boolean => led === 'caps' ? capsLed() : motorLed();

  return { isDown, onDown, onUp, ledOn };
}
