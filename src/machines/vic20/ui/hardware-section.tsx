/**
 * VIC-20 Hardware-pane options: the expansion RAM on the cartridge port.
 * Contributed to the generic Hardware pane via the UI manifest.
 *
 * RAM is fitted with the power off, so each change rebuilds the machine.
 * With 8K or more fitted the KERNAL moves the screen to $1000 and BASIC to
 * $1201; with the 3K alone BASIC starts at $0401.
 */

import { For } from 'solid-js';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';
import { VIC20_RAM_CHOICES, VIC20_RAM_LABELS, type Vic20RamChoice } from '../options.ts';

function rebuild(): void {
  void switchModel(currentModel());
}

export function Vic20HardwareSection() {
  return (
    <>
      <div class="slider-row">
        <span
          class="slider-label"
          title={'Expansion RAM on the cartridge port. 3K fills $0400-$0FFF; 8K, 16K and 24K '
            + 'fill BLK1-3 ($2000-$7FFF). Programs say which they need. The machine rebuilds '
            + 'when this changes.'}
        >
          RAM
        </span>
        <select
          value={settings.vic20Ram()}
          onChange={(event) => {
            const value = (event.target as HTMLSelectElement).value as Vic20RamChoice;
            settings.setVic20Ram(value);
            settings.persistSetting('vic20-ram', value);
            rebuild();
          }}
        >
          <For each={VIC20_RAM_CHOICES}>
            {(c) => <option value={c}>{VIC20_RAM_LABELS[c]}</option>}
          </For>
        </select>
      </div>
      <div class="multiface-row">
        <label class="mf-check" title="Fit 8K of RAM at $A000-$BFFF (BLK5), where cartridges usually go">
          <input
            type="checkbox"
            checked={settings.vic20Blk5()}
            onChange={(event) => {
              const on = (event.target as HTMLInputElement).checked;
              settings.setVic20Blk5(on);
              settings.persistSetting('vic20-blk5', on ? 'on' : 'off');
              rebuild();
            }}
          />
          RAM at $A000 (BLK5)
        </label>
      </div>
    </>
  );
}
