/**
 * The Commodore 64's keyboard: the shared breadbin keyboard
 * (`shared/ui/cbm-keyboard`) on the running 64.
 */

import { CbmKeyboardPane } from '@/machines/shared/ui/cbm-keyboard/CbmKeyboardPane.tsx';
import { activeC64 } from '@/machines/c64/ui/active.ts';

export function KeyboardPane() {
  return <CbmKeyboardPane active={activeC64} label="Commodore 64 keyboard" />;
}
