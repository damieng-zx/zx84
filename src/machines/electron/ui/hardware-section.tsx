/**
 * Electron-specific Hardware-pane options: the Plus 1 and Plus 3 expansions.
 *
 * This contribution may narrow to its own machine folder; the generic Hardware
 * pane remains machine-blind and loads it through the UI manifest. Both
 * expansions load a ROM at build time, so toggling one rebuilds the machine.
 */

import * as settings from '@/store/settings.ts';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';

export function ElectronHardwareSection() {
  const toggle = (key: 'electron-plus1' | 'electron-plus3', enabled: boolean): void => {
    if (key === 'electron-plus1') settings.setElectronPlus1(enabled);
    else settings.setElectronPlus3(enabled);
    settings.persistSetting(key, enabled ? 'on' : 'off');
    // The expansion ROM is fitted at build time, so rebuild to add/remove it.
    void switchModel(currentModel());
  };
  return (
    <>
      <div class="multiface-row">
        <label
          class="mf-check"
          title={'Acorn Plus 1: two ROM cartridge slots (load a .rom from the ROM pane; '
            + 'SHIFT+BREAK runs it), the printer port and the analogue joystick ports.'}
        >
          <input
            type="checkbox"
            checked={settings.electronPlus1()}
            onChange={(event) => toggle('electron-plus1', (event.target as HTMLInputElement).checked)}
          />
          Plus 1 (cartridges)
        </label>
      </div>
      <div class="multiface-row">
        <label
          class="mf-check"
          title={'Acorn Plus 3: a WD1770 disc interface with the ADFS ROM and two drives '
            + '(.adf, .adl, .ads, .adm discs; SHIFT+BREAK boots drive 0).'}
        >
          <input
            type="checkbox"
            checked={settings.electronPlus3()}
            onChange={(event) => toggle('electron-plus3', (event.target as HTMLInputElement).checked)}
          />
          Plus 3 (disc drives)
        </label>
      </div>
    </>
  );
}
