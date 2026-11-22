/**
 * The ASCII code an Acorn deck cap sends on the System machines.
 *
 * The deck is the same one the Atom has (see `@/ui/keyboard/AcornDeck.tsx`),
 * but a System keyboard is an encoder, not a matrix: a cap puts a 7-bit ASCII
 * code on the port. The caps with no ASCII of their own take the code the
 * system software gives them:
 *
 *   ESC     &1B     RETURN  &0D     DELETE  &7F
 *   COPY    Ctrl-Q  — the DOS's copy key
 *   ←/→     Ctrl-A / Ctrl-S, ↑/↓ Ctrl-W / Ctrl-Z — the DOS's cursor moves
 *
 * SHIFT and CTRL latch, LOCK swaps the letters' case, REPT is the host's
 * auto-repeat, and BREAK resets the machine.
 */

import type { DeckKeyDef } from '@/ui/keyboard/deck-layout.ts';

/** Faces that are not the character printed on them. */
const SPECIAL: Readonly<Record<string, number>> = {
  ESC: 0x1b,
  RETURN: 0x0d,
  DELETE: 0x7f,
  COPY: 0x11,
  '↔': 0x01,
  '↕': 0x1a,
  '↑': 0x17,
};

/**
 * The byte a cap sends, or null when it is a modifier or a cap with no code
 * (LOCK, which the driver treats as a case latch).
 */
export function deckKeyByte(
  key: Pick<DeckKeyDef, 'main' | 'shift' | 'action'>,
  shift: boolean,
  ctrl: boolean,
  lower = false,
): number | null {
  if (key.action !== 'key') return null;
  if (key.main === 'LOCK' || key.main === '') return null;

  const special = SPECIAL[key.main];
  if (special !== undefined) return special;

  const face = shift && key.shift ? key.shift : key.main;
  const ch = face.charAt(0);
  if (ch.length === 0) return null;

  if (ctrl && ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) & 0x1f;
  if (lower && ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) + 0x20;
  return ch.charCodeAt(0);
}
