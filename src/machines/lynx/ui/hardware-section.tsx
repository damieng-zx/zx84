/**
 * Lynx-specific Hardware-pane options: the FD1793 disk-interface toggle.
 * Contributed to the generic Hardware pane via the UI manifest.
 *
 * Switching it off removes the DOS ROM socket and hides the Drives pane; the
 * machine is rebuilt so the ROM pane and services reflect the new fit.
 */

import { Show } from 'solid-js';
import { currentModel } from '@/state/machine-state.ts';
import { machineCaps } from '@/state/machine-caps.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';

export function LynxHardwareSection() {
  return (
    <Show when={machineCaps().builtinDisk}>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Fit the FD1793 disk interface and load its DOS ROM"
        >
          <input
            type="checkbox"
            checked={settings.lynxFdc()}
            onChange={(e) => {
              const on = (e.target as HTMLInputElement).checked;
              settings.setLynxFdc(on);
              settings.persistSetting('lynx-fdc', on ? 'on' : 'off');
              void switchModel(currentModel());
            }}
          />
          Disk interface (FD1793)
        </label>
      </div>
    </Show>
  );
}
