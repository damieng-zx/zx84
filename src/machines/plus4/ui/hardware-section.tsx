/**
 * Plus/4 Hardware-pane options: the disk drive on the serial bus.
 * Contributed to the generic Hardware pane via the UI manifest.
 */

import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';

function rebuild(): void {
  void switchModel(currentModel());
}

export function Plus4HardwareSection() {
  return (
    <>
      <div class="multiface-row plus4-hw-row">
        <label
          class="mf-check"
          title="Plug a disk drive (device 8) into the serial bus: a 1541, 1571 or 1581, chosen in the Drives pane"
        >
          <input
            type="checkbox"
            checked={settings.plus4Drive()}
            onChange={(event) => {
              const on = (event.target as HTMLInputElement).checked;
              settings.setPlus4Drive(on);
              settings.persistSetting('plus4-drive', on ? 'on' : 'off');
              rebuild();
            }}
          />
          Disk drive (device 8)
        </label>
      </div>
    </>
  );
}
