/**
 * Atari on-screen keyboard interaction and live highlighting, shared by the
 * 400 and XL faces.
 *
 * There is no matrix to mirror: POKEY reports one key at a time, so a cap
 * lights while it is held under the pointer or while KBCODE says the host
 * keyboard is holding it. SHIFT and CONTROL latch one-shot, as on the other
 * faces: click to latch, and the next ordinary key takes them and clears them.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeAtari } from '@/machines/atari/ui/active.ts';
import type { AtariKeyAction } from './layout.ts';

export interface AtariKeyboardController {
  isDown(action: AtariKeyAction): boolean;
  onDown(action: AtariKeyAction): void;
  onUp(action: AtariKeyAction): void;
  /** PIA port B as the pins see it; on the 1200XL bits 2 and 3 drive the L1
   *  and L2 lamps, lit when low. */
  portB(): number;
}

export function useAtariKeyboard(): AtariKeyboardController {
  const [heldCode, setHeldCode] = createSignal(-1);
  const [shiftHeld, setShiftHeld] = createSignal(false);
  const [consoleKeys, setConsoleKeys] = createSignal(0x07);
  const [portB, setPortB] = createSignal(0xFF);
  const [shiftLatched, setShiftLatched] = createSignal(false);
  const [controlLatched, setControlLatched] = createSignal(false);
  /** Keys held under the pointer: `scan:<code>`, `console:<bit>`, and
   *  BREAK / SYSTEM RESET by kind. */
  const pressed = new Set<string>();
  const [pressedTick, setPressedTick] = createSignal(0);
  const machine = () => activeAtari();

  const isDown = (action: AtariKeyAction): boolean => {
    pressedTick();
    switch (action.kind) {
      case 'scan':
        return pressed.has(`scan:${action.code}`)
          || (heldCode() >= 0 && (heldCode() & 0x3F) === action.code);
      case 'shift': return shiftLatched() || shiftHeld();
      case 'control': return controlLatched() || (heldCode() >= 0 && (heldCode() & 0x80) !== 0);
      case 'console': return (consoleKeys() & action.bit) === 0;
      case 'break':
      case 'reset':
        return pressed.has(action.kind);
    }
  };

  const setPressed = (id: string, down: boolean) => {
    if (down) pressed.add(id);
    else pressed.delete(id);
    setPressedTick((n) => n + 1);
  };

  const releaseLatches = () => {
    if (shiftLatched()) machine()?.holdShift(false);
    setShiftLatched(false);
    setControlLatched(false);
  };

  const onDown = (action: AtariKeyAction) => {
    const m = machine();
    if (!m) return;
    switch (action.kind) {
      case 'scan': {
        const id = `scan:${action.code}`;
        if (pressed.has(id)) return;
        setPressed(id, true);
        m.pressScanKey(action.code, shiftLatched(), controlLatched());
        return;
      }
      case 'shift': {
        const next = !shiftLatched();
        setShiftLatched(next);
        m.holdShift(next);
        return;
      }
      case 'control':
        setControlLatched(!controlLatched());
        return;
      case 'console':
        setPressed(`console:${action.bit}`, true);
        m.setConsoleKey(action.bit, true);
        return;
      case 'break':
        setPressed('break', true);
        m.pressBreak();
        return;
      case 'reset':
        setPressed('reset', true);
        m.pressSystemReset();
        return;
    }
  };

  const onUp = (action: AtariKeyAction) => {
    const m = machine();
    switch (action.kind) {
      case 'scan': {
        const id = `scan:${action.code}`;
        if (!pressed.has(id)) return;
        setPressed(id, false);
        m?.releaseScanKey();
        releaseLatches();
        return;
      }
      case 'console':
        setPressed(`console:${action.bit}`, false);
        m?.setConsoleKey(action.bit, false);
        return;
      case 'break':
        setPressed('break', false);
        releaseLatches();
        return;
      case 'reset':
        setPressed('reset', false);
        return;
      default:
        return; // modifiers toggle on press only
    }
  };

  // Per-frame poll, so host keystrokes light the face's caps too.
  onMount(() => {
    let raf = 0;
    const tick = () => {
      const m = machine();
      setHeldCode(m ? m.heldKeyCode : -1);
      setShiftHeld(m ? m.shiftHeld : false);
      setConsoleKeys(m ? m.consoleKeys : 0x07);
      setPortB(m ? m.memory.portB : 0xFF);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      // Nothing may stay held once the pane is gone.
      const m = machine();
      if (m) {
        for (const id of pressed) {
          if (id.startsWith('scan:')) m.releaseScanKey();
          else if (id.startsWith('console:')) m.setConsoleKey(Number(id.slice(8)), false);
        }
        if (shiftLatched()) m.holdShift(false);
      }
      pressed.clear();
    });
  });

  return { isDown, onDown, onUp, portB };
}
