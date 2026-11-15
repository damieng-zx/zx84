/**
 * C128-specific Hardware-pane options: which video chip the canvas shows, the
 * VDC's RAM, and the disk drive on the serial bus. Contributed to the generic
 * Hardware pane via the UI manifest.
 *
 * The display choice takes effect at once. The VDC's RAM and the drive are
 * fitted with the power off, so each change rebuilds the machine (the Drives
 * pane and the ROM pane follow, and a disk in the drive is carried across).
 * Which drive it is, a 1541, 1571 or 1581, is the Drives pane's Model menu.
 */

import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import { applyDisplaySettings } from '@/shell/settings.ts';
import * as settings from '@/store/settings.ts';

function rebuild(): void {
  void switchModel(currentModel());
}

export function C128HardwareSection() {
  return (
    <>
      <div class="slider-row">
        <span
          class="slider-label"
          title={'Which video chip the screen shows. Auto follows the 40/80 DISPLAY key (and shows '
            + 'the VIC-IIe in C64 mode); 40 or 80 shows that chip whatever the key says.'}
        >
          Display
        </span>
        <select
          id="c128-display-select"
          value={settings.c128Display()}
          onChange={(event) => {
            const value = (event.target as HTMLSelectElement).value as 'auto' | '40' | '80';
            settings.setC128Display(value);
            settings.persistSetting('c128-display', value);
            applyDisplaySettings();
          }}
        >
          <option value="auto">Auto (40/80 key)</option>
          <option value="40">40 columns (VIC-IIe)</option>
          <option value="80">80 columns (VDC)</option>
        </select>
      </div>
      <div class="slider-row">
        <span
          class="slider-label"
          title={'The 8563 VDC\'s RAM: 16K as on the 128, or 64K as on the 128D and later boards '
            + '(more room for the character sets and bitmap modes). The machine rebuilds when this changes.'}
        >
          VDC RAM
        </span>
        <select
          id="c128-vdc-ram-select"
          value={settings.c128VdcRam()}
          onChange={(event) => {
            const value = (event.target as HTMLSelectElement).value as '16k' | '64k';
            settings.setC128VdcRam(value);
            settings.persistSetting('c128-vdc-ram', value);
            rebuild();
          }}
        >
          <option value="16k">16K (128)</option>
          <option value="64k">64K (128D)</option>
        </select>
      </div>
      <div class="slider-row">
        <span
          class="slider-label"
          title={'Which VDC chip is fitted: the early 8563 R7A, the 8563 R8/R9 of the flat 128 and the 128D, or the 8568 of the 128DCR. '
            + 'Software reads the version from the status register (the editor writes a different scroll value for the R7A). '
            + 'The machine rebuilds when this changes.'}
        >
          VDC chip
        </span>
        <select
          id="c128-vdc-chip-select"
          value={settings.c128VdcChip()}
          onChange={(event) => {
            const value = (event.target as HTMLSelectElement).value as 'r7a' | 'r8' | '8568';
            settings.setC128VdcChip(value);
            settings.persistSetting('c128-vdc-chip', value);
            rebuild();
          }}
        >
          <option value="r8">8563 R8/R9 (128, 128D)</option>
          <option value="8568">8568 (128DCR)</option>
          <option value="r7a">8563 R7A (early)</option>
        </select>
      </div>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Plug a disk drive (device 8) into the serial bus: a 1541, 1571 or 1581, chosen in the Drives pane (a 1571 is the 128's own)"
        >
          <input
            type="checkbox"
            checked={settings.c128Drive()}
            onChange={(event) => {
              const on = (event.target as HTMLInputElement).checked;
              settings.setC128Drive(on);
              settings.persistSetting('c128-drive', on ? 'on' : 'off');
              rebuild();
            }}
          />
          Disk drive (device 8)
        </label>
      </div>
    </>
  );
}
