/**
 * Acorn Atom on-screen keyboard interaction and live highlighting.
 *
 * Caps drive the same matrix cells as host keys. CTRL, SHIFT and REPT latch
 * (click to hold, click again to release), so one pointer can type a chord:
 * click SHIFT and then a cap for its shifted symbol. BREAK resets the machine
 * directly, and the cell is held long enough for the OS's keyboard scan.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeAtom } from '../active.ts';
import type { AtomKeyDef } from './layout.ts';

export interface AtomKeyboardController {
  isDown(key: AtomKeyDef): boolean;
  onDown(key: AtomKeyDef): void;
  onUp(key: AtomKeyDef): void;
}

export function useAtomKeyboard(keys: () => readonly AtomKeyDef[]): AtomKeyboardController {
  const [lit, setLit] = createSignal<ReadonlySet<string>>(new Set());
  const [breakLit, setBreakLit] = createSignal(false);
  const machine = () => activeAtom();

  // Latched modifiers, so a SHIFT/CTRL/REPT click survives more than one cap.
  let shiftLatched = false;
  let ctrlLatched = false;
  let reptLatched = false;

  const releaseLatch = () => {
    const kb = machine()?.keyboard;
    if (kb) {
      kb.shiftHeld = false;
      kb.ctrlHeld = false;
      kb.reptHeld = false;
    }
    shiftLatched = ctrlLatched = reptLatched = false;
  };

  const releaseCells = () => { machine()?.keyboard.releaseAll(); };

  const onDown = (key: AtomKeyDef) => {
    const m = machine();
    if (!m) return;
    m.cancelPaste();
    const kb = m.keyboard;
    switch (key.action) {
      case 'shift':
        shiftLatched = !shiftLatched;
        kb.shiftHeld = shiftLatched;
        return;
      case 'ctrl':
        ctrlLatched = !ctrlLatched;
        kb.ctrlHeld = ctrlLatched;
        return;
      case 'rept':
        reptLatched = !reptLatched;
        kb.reptHeld = reptLatched;
        return;
      case 'break':
        setBreakLit(true);
        shiftLatched = ctrlLatched = reptLatched = false;
        m.pressBreak();
        return;
      default:
        kb.setCell(key.row, key.col, true);
    }
  };

  const onUp = (key: AtomKeyDef) => {
    const m = machine();
    if (!m) return;
    const kb = m.keyboard;
    switch (key.action) {
      case 'shift':
      case 'ctrl':
      case 'rept':
        return;
      case 'break':
        setBreakLit(false);
        return;
      default:
        kb.setCell(key.row, key.col, false);
    }
  };

  const litNow = (key: AtomKeyDef): boolean => {
    const kb = machine()?.keyboard;
    if (!kb) return false;
    switch (key.action) {
      case 'shift': return kb.shiftHeld;
      case 'ctrl': return kb.ctrlHeld;
      case 'rept': return kb.reptHeld;
      case 'break': return breakLit();
      default: return kb.isPressed(key.row, key.col);
    }
  };

  // Per-frame poll mirrors host keystrokes onto the caps as well as pointer
  // presses.
  onMount(() => {
    let raf = 0;
    const tick = () => {
      const kb = machine()?.keyboard;
      if (kb) {
        // Keep the local latches in step with a reset/BREAK or a host Shift.
        shiftLatched = kb.shiftHeld;
        ctrlLatched = kb.ctrlHeld;
        reptLatched = kb.reptHeld;
      }
      const current = lit();
      const next = new Set<string>();
      for (const key of keys()) if (litNow(key)) next.add(key.id);
      let changed = next.size !== current.size;
      if (!changed) {
        for (const id of next) if (!current.has(id)) { changed = true; break; }
      }
      if (changed) setLit(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      releaseLatch();
      releaseCells();
    });
  });

  return {
    isDown: (key) => lit().has(key.id),
    onDown,
    onUp,
  };
}
