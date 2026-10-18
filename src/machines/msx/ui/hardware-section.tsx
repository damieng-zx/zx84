/**
 * MSX-specific Hardware-pane options: the floppy disk interface.
 *
 * Contributed to the generic Hardware pane through the UI manifest
 * (`src/ui/machine-ui.ts`). A machine `ui/` file — one of the few MSX files
 * allowed to import solid-js and the shell/settings/state layers.
 */

import { loadAuxRom } from '@/shell/rom.ts';
import { resetMachine } from '@/shell/lifecycle.ts';
import { msxDiskRomFailed } from '@/state/machine-state.ts';
import * as settings from '@/store/settings.ts';
import { msxDiskAuxRom } from '@/machines/msx/aux-roms.ts';
import { activeMsx } from '@/machines/msx/ui/active.ts';

export function MsxHardwareSection() {
  return (
    <div class="multiface-row">
      <label
        class={`mf-check${msxDiskRomFailed() ? ' rom-failed' : ''}`}
        title={msxDiskRomFailed() || 'Floppy disk interface (WD2793 + Disk BASIC ROM in slot 3) — drives A:/B:'}
      >
        <input
          type="checkbox"
          checked={settings.msxFloppy()}
          onChange={(event) => {
            const on = (event.target as HTMLInputElement).checked;
            settings.setMsxFloppy(on);
            settings.persistSetting('msx-floppy', on ? 'on' : 'off');
            const m = activeMsx();
            if (!m) return;
            m.setFloppyEnabled(on);
            // The BIOS finds the Disk BASIC ROM in its power-on slot scan, so
            // the card only takes effect after a reset (and once its ROM is in).
            if (on && !m.diskIf.romLoaded) {
              void loadAuxRom(msxDiskAuxRom(m)).then(() => resetMachine());
            } else {
              resetMachine();
            }
          }}
        />
        Floppy (disk interface)
      </label>
    </div>
  );
}
