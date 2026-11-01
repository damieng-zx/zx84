/**
 * Commodore on-screen keyboard interaction and live highlighting: the caps
 * drive the running machine's keyboard through `CbmOnScreenKeys`, and a
 * per-frame poll lights the caps for host keystrokes too. Each machine's own
 * `ui/` says how to reach its running machine (`active`).
 */

import { createSignal, onCleanup, onMount } from 'solid-js';
import type { CbmKeyboard } from '@/machines/shared/cbm/keyboard.ts';
import { CbmOnScreenKeys } from './pad.ts';
import { CBM_KEYS, type CbmKeyDef } from './layout.ts';

export interface CbmKeyboardController {
  isDown(key: CbmKeyDef): boolean;
  onDown(key: CbmKeyDef): void;
  onUp(key: CbmKeyDef): void;
}

/** The running machine's keyboard, or null when another machine is running. */
export type ActiveCbmKeyboard = () => { readonly keyboard: CbmKeyboard } | null;

export function useCbmKeyboard(active: ActiveCbmKeyboard): CbmKeyboardController {
  const [lit, setLit] = createSignal<ReadonlySet<string>>(new Set());
  let pad: CbmOnScreenKeys | null = null;
  let padFor: unknown = null;

  /** The pad for the machine that is running now (a model switch makes a new one). */
  const current = (): CbmOnScreenKeys | null => {
    const m = active();
    if (!m) return null;
    if (padFor !== m) {
      pad?.releaseAll();
      pad = new CbmOnScreenKeys(m.keyboard);
      padFor = m;
    }
    return pad;
  };

  onMount(() => {
    let raf = 0;
    const tick = () => {
      const p = current();
      const next = new Set<string>();
      if (p) for (const key of CBM_KEYS) if (p.lit(key)) next.add(key.id);
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
