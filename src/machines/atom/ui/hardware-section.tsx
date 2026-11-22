/**
 * Acorn Atom Hardware-pane options: the fitted RAM.
 *
 * The 2 KB machine has 1 KB of CPU workspace and 1 KB of display RAM; the 12 KB
 * expansion adds 5 KB of lower text RAM and extends the display to 6 KB. The OS
 * probes memory at reset, so a change rebuilds the machine.
 */

import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';

export function AtomHardwareSection() {
  return (
    <div class="slider-row">
      <span
        class="slider-label"
        title={'RAM fitted. 2K is the standard Atom (1K workspace + 1K display RAM, ' +
          'with the upper half of the display RAM as text space); 12K adds the 5K ' +
          'lower text RAM at $2800 and the remaining 5K of display RAM. Most Atom ' +
          'software assumes 12K. The machine rebuilds when this changes.'}
      >
        RAM
      </span>
      <select
        value={settings.atomRam()}
        onChange={(event) => {
          const value = (event.target as HTMLSelectElement).value as ReturnType<typeof settings.atomRam>;
          settings.setAtomRam(value);
          settings.persistSetting('atom-ram', value);
          void switchModel(currentModel());
        }}
      >
        <option value="2k">2K (standard)</option>
        <option value="12k">12K (expanded)</option>
      </select>
    </div>
  );
}
