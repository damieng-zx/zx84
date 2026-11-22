/**
 * Acorn System on-screen keyboard: the same ASCII deck the Atom has, driving
 * the System's encoder instead of a matrix.
 *
 * SHIFT and CTRL latch (click to hold, click again to release) so one pointer
 * can type a chord; LOCK swaps the letters' case and stays on; REPT is left to
 * the host's auto-repeat. BREAK resets the machine. Every other cap puts its
 * ASCII code on the keyboard port for as long as it is held.
 */

import { createSignal, onCleanup } from 'solid-js';
import { AcornDeck, type DeckDriver } from '@/ui/keyboard/AcornDeck.tsx';
import type { DeckKeyDef } from '@/ui/keyboard/deck-layout.ts';
import { activeAcornSystem } from '../active.ts';
import { deckKeyByte } from '../keyboard-ascii.ts';

/** The cap that swaps the letters' case rather than sending a byte. */
const isCaseLock = (key: DeckKeyDef): boolean => key.main === 'LOCK';

function useAcornSystemDeck(): DeckDriver {
  const [held, setHeld] = createSignal<ReadonlySet<string>>(new Set());
  const [shift, setShift] = createSignal(false);
  const [ctrl, setCtrl] = createSignal(false);
  const [lower, setLower] = createSignal(false);

  const hold = (id: string, on: boolean): void => {
    setHeld((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  };

  const press = (key: DeckKeyDef): void => {
    const machine = activeAcornSystem();
    if (!machine) return;
    hold(key.id, true);
    switch (key.action) {
      case 'shift': setShift(!shift()); return;
      case 'ctrl': setCtrl(!ctrl()); return;
      case 'rept': return;
      case 'break': machine.pressResetKey(); return;
      default: break;
    }
    if (isCaseLock(key)) { setLower(!lower()); return; }
    const byte = deckKeyByte(key, shift(), ctrl(), lower());
    if (byte !== null) machine.pressKey(byte);
  };

  const release = (key: DeckKeyDef): void => {
    hold(key.id, false);
    if (key.action !== 'key' || isCaseLock(key)) return;
    if (deckKeyByte(key, shift(), ctrl(), lower()) !== null) activeAcornSystem()?.releaseKey();
  };

  onCleanup(() => {
    activeAcornSystem()?.releaseKey();
    activeAcornSystem()?.releaseAllKeys();
  });

  return {
    isDown: (key) => {
      switch (key.action) {
        case 'shift': return shift();
        case 'ctrl': return ctrl();
        case 'rept': return false;
        default: break;
      }
      if (isCaseLock(key)) return lower();
      return held().has(key.id);
    },
    onDown: press,
    onUp: release,
  };
}

export function KeyboardPane() {
  const driver = useAcornSystemDeck();
  return (
    <AcornDeck driver={driver} badge="ACORN SYSTEM" label="Acorn System keyboard" />
  );
}
