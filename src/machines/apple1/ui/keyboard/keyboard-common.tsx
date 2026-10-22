/**
 * Apple I on-screen keyboard interaction and live highlighting.
 *
 * Caps feed the same encoder as host keys. SHIFT and CTRL latch one-shot — click
 * to hold, released after the next key — so a single pointer can type a chord.
 * RESET and CLEAR SCREEN act on the machine directly, as they do on the board.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeApple1 } from '@/machines/apple1/ui/active.ts';
import type { Apple1KeyDef } from './layout.ts';

export interface Apple1KeyboardController {
  isDown(key: Apple1KeyDef): boolean;
  onDown(key: Apple1KeyDef): void;
  onUp(key: Apple1KeyDef): void;
}

export function useApple1Keyboard(keys: () => readonly Apple1KeyDef[]): Apple1KeyboardController {
  const [lit, setLit] = createSignal<ReadonlySet<string>>(new Set());
  const machine = () => activeApple1();

  const releaseModifiers = () => {
    const kb = machine()?.keyboard;
    if (!kb) return;
    kb.shiftHeld = false;
    kb.ctrlHeld = false;
    kb.track('ShiftLeft', false);
    kb.track('ShiftRight', false);
    kb.track('ControlLeft', false);
  };

  const onDown = (key: Apple1KeyDef) => {
    const m = machine();
    if (!m) return;
    const kb = m.keyboard;
    switch (key.action) {
      case 'shift':
        kb.shiftHeld = !kb.shiftHeld;
        kb.track(key.face, kb.shiftHeld);
        return;
      case 'ctrl':
        kb.ctrlHeld = !kb.ctrlHeld;
        kb.track(key.face, kb.ctrlHeld);
        return;
      case 'reset': kb.track(key.face, true); m.pressResetKey(); return;
      case 'clear': kb.track(key.face, true); m.pressClearScreenKey(); return;
      default: kb.pressFace(key.face, true);
    }
  };

  const onUp = (key: Apple1KeyDef) => {
    const kb = machine()?.keyboard;
    if (!kb || key.action === 'shift' || key.action === 'ctrl') return;
    kb.track(key.face, false);
    // One-shot: drop latched modifiers once an ordinary key is used.
    if (key.action === 'char') releaseModifiers();
  };

  const litNow = (key: Apple1KeyDef): boolean => {
    const kb = machine()?.keyboard;
    if (!kb) return false;
    return kb.isHeld(key.face) || (key.host?.some((code) => kb.isHeld(code)) ?? false);
  };

  // Per-frame poll: mirror the live keyboard so host keystrokes light the caps
  // too, not just pointer presses.
  onMount(() => {
    let raf = 0;
    const tick = () => {
      const current = lit();
      const next = new Set<string>();
      for (const key of keys()) if (litNow(key)) next.add(key.id);
      let changed = next.size !== current.size;
      if (!changed) for (const id of next) if (!current.has(id)) { changed = true; break; }
      if (changed) setLit(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      releaseModifiers();
    });
  });

  return {
    isDown: (key) => lit().has(key.id),
    onDown,
    onUp,
  };
}
