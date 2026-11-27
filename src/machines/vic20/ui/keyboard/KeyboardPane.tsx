/**
 * The VIC-20's keyboard: the same breadbin caps as the C64's
 * (`shared/ui/cbm-keyboard`), pressing the VIC-20's own matrix.
 */

import { CbmKeyboardPane } from '@/machines/shared/ui/cbm-keyboard/CbmKeyboardPane.tsx';
import { activeVic20 } from '@/machines/vic20/ui/active.ts';

export function KeyboardPane() {
  return <CbmKeyboardPane active={activeVic20} label="Commodore VIC-20 keyboard" />;
}
