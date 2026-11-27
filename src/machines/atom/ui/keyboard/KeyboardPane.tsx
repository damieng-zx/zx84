/**
 * Acorn Atom on-screen keyboard: the machine's QWERTY deck on its black plate,
 * with the green ACORN ATOM badge beside the space bar.
 *
 * The deck itself is shared with the System machines (see
 * `@/ui/keyboard/AcornDeck.tsx`); this pane supplies the Atom's matrix driver.
 */

import { AcornDeck } from '@/ui/keyboard/AcornDeck.tsx';
import { useAtomKeyboard } from './keyboard-common.tsx';
import { DECK_KEYS } from '@/ui/keyboard/deck-layout.ts';

export function KeyboardPane() {
  const keyboard = useAtomKeyboard(() => DECK_KEYS);
  return (
    <AcornDeck
      driver={keyboard}
      badge="ACORN ATOM"
      label="Acorn Atom keyboard"
    />
  );
}
