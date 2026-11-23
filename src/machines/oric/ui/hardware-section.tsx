/**
 * Oric Hardware-pane options: whether a Microdisc is fitted.
 *
 * The disk interface is an add-on card, and fitting one changes both the memory
 * map (its boot EPROM takes $E000) and the drives the Drives pane shows, so the
 * machine rebuilds when this changes.
 */

import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';

export function OricHardwareSection() {
  return (
    <div class="slider-row">
      <span
        class="slider-label"
        title={'Microdisc: a Western Digital WD1793 floppy controller with its own 8 KB boot EPROM, ' +
          'which maps 8 KB of ROM at $E000 and lets the overlay RAM at $C000 replace the BASIC ROM. ' +
          'That is what a Sedoric disk boots through. The machine rebuilds when this changes.'}
      >
        Microdisc
      </span>
      <select
        value={settings.oricMicrodisc() ? 'on' : 'off'}
        onChange={(event) => {
          const value = (event.target as HTMLSelectElement).value === 'on';
          settings.setOricMicrodisc(value);
          settings.persistSetting('oric-microdisc', value ? 'on' : 'off');
          void switchModel(currentModel());
        }}
      >
        <option value="off">Not fitted</option>
        <option value="on">Fitted (WD1793 + EPROM)</option>
      </select>
    </div>
  );
}
