/**
 * Enterprise Hardware-pane options: the EXDOS disk card.
 *
 * The card's ROM is fitted at build time, so toggling it rebuilds the
 * machine. Extension ROMs (EPDOS, ZozoTools, …) go in the ROM pane's
 * extension sockets.
 */

import * as settings from '@/store/settings.ts';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';

export function EnterpriseHardwareSection() {
  return (
    <div class="multiface-row">
      <label
        class="mf-check"
        title={'EXDOS disk card: a WD1770 and the EXDOS 1.3 ROM, four drives of '
          + '720K .img disks. A disk in A: boots when it is loaded.'}
      >
        <input
          type="checkbox"
          checked={settings.enterpriseExdos()}
          onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked;
            settings.setEnterpriseExdos(on);
            settings.persistSetting('enterprise-exdos', on ? 'on' : 'off');
            void switchModel(currentModel());
          }}
        />
        EXDOS disk card
      </label>
    </div>
  );
}
