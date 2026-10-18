/**
 * Electron-specific Hardware-pane options: the Plus 1 and Plus 3 expansions,
 * and whether the Plus 3's drives run ADFS or the ACP 1770 DFS.
 *
 * This contribution may narrow to its own machine folder; the generic Hardware
 * pane remains machine-blind and loads it through the UI manifest. Both
 * expansions load a ROM at build time, so toggling one rebuilds the machine.
 */

import * as settings from '@/store/settings.ts';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';

export function ElectronHardwareSection() {
  const toggle = (key: 'electron-plus1' | 'electron-plus3' | 'electron-dfs', enabled: boolean): void => {
    if (key === 'electron-plus1') settings.setElectronPlus1(enabled);
    else if (key === 'electron-plus3') settings.setElectronPlus3(enabled);
    else settings.setElectronDfs(enabled);
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
      <div class="multiface-row">
        <label
          class="mf-check"
          title={'Swap the ADFS ROM on the Plus 3 for the ACP 1770 DFS, so the drives read Acorn DFS '
            + 'discs (.ssd, .dsd) instead of ADFS ones; SHIFT+BREAK boots drive 0.'}
        >
          <input
            type="checkbox"
            checked={settings.electronDfs()}
            disabled={!settings.electronPlus3()}
            onChange={(event) => toggle('electron-dfs', (event.target as HTMLInputElement).checked)}
          />
          DFS instead of ADFS (.ssd/.dsd)
        </label>
      </div>
    </>
  );
}
