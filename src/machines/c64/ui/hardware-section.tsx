/**
 * C64-specific Hardware-pane options: the disk drive on the serial bus.
 * Contributed to the generic Hardware pane via the UI manifest.
 *
 * Unplugging it leaves the bus empty, as a 64 with no drive is: LOAD ,8 then
 * gets no answer. The machine is rebuilt so the Drives pane and the ROM pane
 * follow the change, and a disk in the drive is carried across. Which drive
 * it is, a 1541 or a 1581, is the Drives pane's Model menu.
 */

import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';

export function C64HardwareSection() {
  return (
    <div class="multiface-row">
      <label
        class="mf-check"
        title="Plug a disk drive (device 8) into the serial bus: a 1541 or a 1581, chosen in the Drives pane"
      >
        <input
          type="checkbox"
          checked={settings.c64Drive()}
          onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked;
            settings.setC64Drive(on);
            settings.persistSetting('c64-drive', on ? 'on' : 'off');
            void switchModel(currentModel());
          }}
        />
        Disk drive (device 8)
      </label>
    </div>
  );
}
