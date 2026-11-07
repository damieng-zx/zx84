/**
 * C64 on-screen keyboard interaction and live highlighting: the caps drive the
 * machine's keyboard through `C64OnScreenKeys`, and a per-frame poll lights
 * the caps for host keystrokes too.
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import { activeC64 } from '@/machines/c64/ui/active.ts';
import { C64OnScreenKeys } from './pad.ts';
import { C64_KEYS, type C64KeyDef } from './layout.ts';

export interface C64KeyboardController {
  isDown(key: C64KeyDef): boolean;
  onDown(key: C64KeyDef): void;
  onUp(key: C64KeyDef): void;
}

export function useC64Keyboard(): C64KeyboardController {
  const [lit, setLit] = createSignal<ReadonlySet<string>>(new Set());
  let pad: C64OnScreenKeys | null = null;
  let padFor: unknown = null;

  /** The pad for the machine that is running now (a model switch makes a new one). */
  const current = (): C64OnScreenKeys | null => {
    const m = activeC64();
    if (!m) return null;
    if (padFor !== m) {
      pad?.releaseAll();
      pad = new C64OnScreenKeys(m.keyboard);
      padFor = m;
    }
    return pad;
  };

  onMount(() => {
    let raf = 0;
    const tick = () => {
      const p = current();
      const next = new Set<string>();
      if (p) for (const key of C64_KEYS) if (p.lit(key)) next.add(key.id);
      const was = lit();
      let changed = next.size !== was.size;
      if (!changed) for (const id of next) if (!was.has(id)) { changed = true; break; }
      if (changed) setLit(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      pad?.releaseAll();
    });
  });

  return {
    isDown: (key) => lit().has(key.id),
    onDown: (key) => current()?.press(key),
    onUp: (key) => current()?.release(key),
  };
}
