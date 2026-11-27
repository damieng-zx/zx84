/**
 * What pressing the on-screen caps does to a Commodore keyboard, free of any
 * framework so it can be tested against a real machine.
 *
 * Caps press the same matrix keys the host keyboard does, counted, so a cap
 * and a typed key holding the same SHIFT do not release each other. SHIFT,
 * CTRL and C= latch for one keystroke (click, then the next ordinary key takes
 * them with it) so a single pointer can type SHIFT+RETURN or C=+1; SHIFT LOCK
 * is the real latching switch and stays down until clicked again; RESTORE
 * pulls the NMI line while held.
 */

import type { CbmKeyboard } from '@/machines/shared/cbm/keyboard.ts';
import type { CbmKeyDef } from './layout.ts';

export class CbmOnScreenKeys {
  /** Modifier caps latched for the next keystroke. */
  private readonly latched = new Set<string>();
  /** Ordinary caps held under the pointer, by cap id, with the key each presses. */
  private readonly down = new Map<string, string>();
  private lock = false;

  constructor(private readonly keyboard: CbmKeyboard) {}

  get shiftLocked(): boolean { return this.lock; }

  press(key: CbmKeyDef): void {
    const kb = this.keyboard;
    switch (key.action) {
      case 'modifier': {
        const name = key.name!;
        if (this.latched.delete(name)) kb.setKey(name, false);
        else { this.latched.add(name); kb.setKey(name, true); }
        return;
      }
      case 'shift-lock':
        this.lock = !this.lock;
        kb.setKey('lshift', this.lock);
        return;
      case 'restore':
        kb.restore = true;
        return;
      case 'key':
        if (this.down.has(key.id)) return;
        this.down.set(key.id, key.name!);
        kb.setKey(key.name!, true);
        return;
    }
  }

  release(key: CbmKeyDef): void {
    const kb = this.keyboard;
    if (key.action === 'restore') {
      kb.restore = false;
      this.dropLatches();
      return;
    }
    if (key.action !== 'key' || !this.down.delete(key.id)) return;
    kb.setKey(key.name!, false);
    this.dropLatches();
  }

  /** Whether the cap should look pressed: held, latched, locked, or typed on the host keyboard. */
  lit(key: CbmKeyDef): boolean {
    switch (key.action) {
      case 'shift-lock': return this.lock;
      case 'restore': return this.keyboard.restore;
      default: return this.keyboard.isPressed(key.name!);
    }
  }

  /** Let go of everything this pad is holding (the pane going away). */
  releaseAll(): void {
    this.dropLatches();
    if (this.lock) { this.keyboard.setKey('lshift', false); this.lock = false; }
    for (const name of this.down.values()) this.keyboard.setKey(name, false);
    this.down.clear();
    this.keyboard.restore = false;
  }

  private dropLatches(): void {
    for (const name of this.latched) this.keyboard.setKey(name, false);
    this.latched.clear();
  }
}
