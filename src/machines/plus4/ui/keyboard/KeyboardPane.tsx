/**
 * The Plus/4's keyboard: the shared breadbin-cap keyboard
 * (`shared/ui/cbm-keyboard`) on the running machine. The caps are the same 66
 * the 64 has, minus RESTORE (which is hardware on this board) and with the
 * function keys' shifted halves on the front face; the matrix they press is
 * `PLUS4_MATRIX`.
 */

import { CbmKeyboardPane } from '@/machines/shared/ui/cbm-keyboard/CbmKeyboardPane.tsx';
import { activePlus4 } from '@/machines/plus4/ui/active.ts';

export function KeyboardPane() {
  return <CbmKeyboardPane active={activePlus4} label="Commodore Plus/4 keyboard" />;
}
