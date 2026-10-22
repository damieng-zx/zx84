/**
 * Apple I Hardware-pane options: the memory that is fitted.
 *
 * Contributed to the generic Hardware pane via the UI manifest. RAM is fitted at
 * build time, so each change rebuilds the machine.
 */

import { For } from 'solid-js';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';
import { APPLE1_RAM_SIZES } from '../options.ts';

function rebuild(): void {
  void switchModel(currentModel());
}

export function Apple1HardwareSection() {
  return (
    <>
      <div class="slider-row">
        <span
          class="slider-label"
          title={'RAM fitted from $0000. The board holds 4K or 8K; larger sizes are '
            + 'memory expansion cards. The machine rebuilds when this changes.'}
        >
          RAM
        </span>
        <select
          value={settings.apple1Ram()}
          onChange={(event) => {
            const value = (event.target as HTMLSelectElement).value as ReturnType<typeof settings.apple1Ram>;
            settings.setApple1Ram(value);
            settings.persistSetting('apple1-ram', value);
            rebuild();
          }}
        >
          <For each={APPLE1_RAM_SIZES}>
            {(kb) => <option value={`${kb}k`}>{kb}K</option>}
          </For>
        </select>
      </div>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Fit a 4K RAM card at $E000-$EFFF, where Apple BASIC is loaded from tape"
        >
          <input
            type="checkbox"
            checked={settings.apple1BasicRam()}
            onChange={(event) => {
              const on = (event.target as HTMLInputElement).checked;
              settings.setApple1BasicRam(on);
              settings.persistSetting('apple1-basic-ram', on ? 'on' : 'off');
              rebuild();
            }}
          />
          BASIC RAM card (4K at $E000)
        </label>
      </div>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Fit the Apple Cassette Interface: a tape port (load .wav recordings) and its ROM at $C100"
        >
          <input
            type="checkbox"
            checked={settings.apple1Aci()}
            onChange={(event) => {
              const on = (event.target as HTMLInputElement).checked;
              settings.setApple1Aci(on);
              settings.persistSetting('apple1-aci', on ? 'on' : 'off');
              rebuild();
            }}
          />
          Cassette Interface (ACI)
        </label>
      </div>
    </>
  );
}
