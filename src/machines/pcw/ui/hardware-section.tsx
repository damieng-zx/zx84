/**
 * PCW Hardware-pane options: the 50/60Hz link. Contributed to the generic
 * Hardware pane via the UI manifest (`src/ui/machine-ui.ts`).
 *
 * The link sets the gate array's frame length (312 or 260 lines) and how much
 * of the picture is shown (256 or 200 lines), and is reported to software in
 * status bit 4, which CP/M and LocoScript read to pick a 32- or 25-line
 * screen. It is fitted at build time, so changing it rebuilds the machine.
 */

import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';

export function PcwHardwareSection() {
  return (
    <div class="multiface-row">
      <label
        class="mf-check"
        title={'Fit the motherboard link for a 60Hz display: a 60Hz frame showing 200 of the '
          + '256 lines (a 25-line screen). The machine restarts when this changes.'}
      >
        <input
          type="checkbox"
          checked={settings.pcw60Hz()}
          onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked;
            settings.setPcw60Hz(on);
            settings.persistSetting('pcw-60hz', on ? 'on' : 'off');
            void switchModel(currentModel());
          }}
        />
        60Hz (25-line screen)
      </label>
    </div>
  );
}
