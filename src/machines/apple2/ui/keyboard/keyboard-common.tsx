/**
 * Apple II on-screen keyboard interaction and live highlighting.
 *
 * Caps feed the same encoder as host keys: a press works out the byte from the
 * cap and the modifiers held, and latches it. SHIFT, CTRL and the //e's Apple
 * keys latch one-shot — click to hold, released after the next key — so a single
 * pointer can type a chord like CTRL-RESET or Open-Apple-CTRL-RESET. CAPS LOCK
 * toggles and stays down, as the real latching key does.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeApple2 } from '@/machines/apple2/ui/active.ts';
import { apple2eKeyByte, apple2FaceByte } from '@/machines/apple2/apple2-keyboard.ts';
import type { Apple2KeyboardVariant, Apple2KeyDef } from './layout.ts';

/** The ][ REPT key's repeat rate: about ten characters a second. */
const REPEAT_MS = 100;

const MODIFIER_ACTIONS = new Set(['shift', 'ctrl', 'open-apple', 'solid-apple']);

export interface Apple2KeyboardController {
  isDown(key: Apple2KeyDef): boolean;
  onDown(key: Apple2KeyDef): void;
  onUp(key: Apple2KeyDef): void;
}

export function useApple2Keyboard(
  variant: () => Apple2KeyboardVariant,
  keys: () => readonly Apple2KeyDef[],
): Apple2KeyboardController {
  const [lit, setLit] = createSignal<ReadonlySet<string>>(new Set());
  const latched = new Set<string>();
  let repeatTimer: ReturnType<typeof setInterval> | undefined;
  const machine = () => activeApple2();

  const releaseLatched = () => {
    const kb = machine()?.keyboard;
    if (kb) for (const face of latched) kb.pressFace(face, null, false);
    latched.clear();
  };

  const stopRepeat = () => {
    if (repeatTimer !== undefined) clearInterval(repeatTimer);
    repeatTimer = undefined;
  };

  const byteFor = (key: Apple2KeyDef): number | null => {
    const kb = machine()?.keyboard;
    if (!kb) return null;
    if (variant() === 'apple2') return apple2FaceByte(key.face, kb.shiftHeld, kb.ctrlHeld);
    return apple2eKeyByte(
      { code: key.face, key: '', shift: kb.shiftHeld, ctrl: kb.ctrlHeld, alt: false },
      kb.capsLocked,
    );
  };

  const onDown = (key: Apple2KeyDef) => {
    const m = machine();
    if (!m) return;
    const kb = m.keyboard;
    if (MODIFIER_ACTIONS.has(key.action)) {
      if (latched.delete(key.face)) kb.pressFace(key.face, null, false);
      else { latched.add(key.face); kb.pressFace(key.face, null, true); }
      return;
    }
    switch (key.action) {
      case 'caps-lock': kb.toggleCapsLock(); return;
      case 'reset': m.pressResetKey(); return;
      case 'repeat':
        stopRepeat();
        repeatTimer = setInterval(() => machine()?.keyboard.repeat(), REPEAT_MS);
        return;
      default: {
        const byte = byteFor(key);
        if (byte !== null) kb.pressFace(key.face, byte, true);
      }
    }
  };

  const onUp = (key: Apple2KeyDef) => {
    if (MODIFIER_ACTIONS.has(key.action) || key.action === 'caps-lock') return;
    if (key.action === 'repeat') { stopRepeat(); return; }
    machine()?.keyboard.pressFace(key.face, null, false);
    // One-shot: drop latched modifiers once an ordinary key (or RESET) is used.
    releaseLatched();
  };

  const litNow = (key: Apple2KeyDef): boolean => {
    const kb = machine()?.keyboard;
    if (!kb) return false;
    switch (key.action) {
      case 'caps-lock': return kb.capsLocked;
      case 'repeat': return repeatTimer !== undefined;
      default:
        return kb.isHeld(key.face) || (key.host?.some((code) => kb.isHeld(code)) ?? false);
    }
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
      stopRepeat();
      releaseLatched();
    });
  });

  return {
    isDown: (key) => lit().has(key.id),
    onDown,
    onUp,
  };
}
