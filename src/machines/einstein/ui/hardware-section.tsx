/**
 * Einstein-specific Hardware-pane options: the Xtal DOS boot toggle. Contributed
 * to the generic Hardware pane via the UI manifest (`src/ui/machine-ui.ts`).
 */

import { setEinsteinXtalDosEnabled } from '@/shell/media.ts';
import * as settings from '@/store/settings.ts';

export function EinsteinHardwareSection() {
  return (
    <div class="multiface-row">
      <label class="mf-check" title="Boot Xtal DOS from disk when no disk is in drive 0">
        <input
          type="checkbox"
          checked={settings.einsteinXtalDos()}
          onChange={(e) => setEinsteinXtalDosEnabled((e.target as HTMLInputElement).checked)}
        />
        Xtal DOS
      </label>
    </div>
  );
}
