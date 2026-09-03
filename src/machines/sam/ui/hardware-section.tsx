/**
 * SAM-specific Hardware-pane options.
 *
 * This contribution may narrow to its own machine folder; the generic Hardware
 * pane stays machine-blind and loads it through the UI manifest.
 */

import { machine } from '@/shell/context.ts';
import * as settings from '@/store/settings.ts';
import type { SamMachine } from '../sam-machine.ts';

function activeSam(): SamMachine | null {
  return machine?.kind === 'sam' ? machine as unknown as SamMachine : null;
}

export function SamHardwareSection() {
  return (
    <>
      <div class="multiface-row">
        <label
          class="mf-check"
          title={'Round each instruction up to the ASIC\'s memory slot — 4 T-states '
            + 'over the border, 8 over the display. Turn off for uncontended speed.'}
        >
          <input
            type="checkbox"
            checked={settings.samContention()}
            onChange={(event) => {
              const enabled = (event.target as HTMLInputElement).checked;
              settings.setSamContention(enabled);
              settings.persistSetting('sam-contention', enabled ? 'on' : 'off');
              // Live: the quantiser is consulted per instruction, so this takes
              // effect on the next one. No reset needed.
              const sam = activeSam();
              if (sam) sam.contention.enabled = enabled;
            }}
          />
          Contention
        </label>
      </div>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Write-protect the disk in drive 1"
        >
          <input
            type="checkbox"
            checked={settings.samWriteProtect1()}
            onChange={(event) => {
              const on = (event.target as HTMLInputElement).checked;
              settings.setSamWriteProtect1(on);
              settings.persistSetting('sam-write-protect-1', on ? 'on' : 'off');
              activeSam()?.disk.setWriteProtect(0, on);
            }}
          />
          WP drive 1
        </label>
      </div>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Write-protect the disk in drive 2"
        >
          <input
            type="checkbox"
            checked={settings.samWriteProtect2()}
            onChange={(event) => {
              const on = (event.target as HTMLInputElement).checked;
              settings.setSamWriteProtect2(on);
              settings.persistSetting('sam-write-protect-2', on ? 'on' : 'off');
              activeSam()?.disk.setWriteProtect(1, on);
            }}
          />
          WP drive 2
        </label>
      </div>
    </>
  );
}
