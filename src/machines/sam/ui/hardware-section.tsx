/**
 * SAM-specific Hardware-pane options.
 *
 * This contribution may narrow to its own machine folder; the generic Hardware
 * pane stays machine-blind and loads it through the UI manifest.
 *
 * Only genuinely SAM-specific hardware belongs here. Contention is the Display
 * pane's Accuracy drop-down and write-protect is the Drive pane's per-drive
 * toggle — both shared with every other machine, and neither gets a second
 * control here.
 */

import { For } from 'solid-js';
import { machine } from '@/shell/context.ts';
import * as settings from '@/store/settings.ts';
import { SAM_MAX_EXTERNAL_MB } from '../constants.ts';
import { samExternalPages } from '../models.ts';
import type { SamMachine } from '../sam-machine.ts';

function activeSam(): SamMachine | null {
  return machine?.kind === 'sam' ? machine as unknown as SamMachine : null;
}

/** The sizes the megabyte interface was sold in, plus "not fitted". */
const EXTERNAL_SIZES = Array.from(
  { length: SAM_MAX_EXTERNAL_MB + 1 },
  (_, mb) => ({ mb, label: mb === 0 ? 'None' : `${mb} MB` }),
);

export function SamHardwareSection() {
  return (
    <div class="slider-row sam-ram-row">
      <span
        class="slider-label"
        title={'RAM fitted to the external megabyte interface, reached through '
          + 'the LEPR/HEPR page registers. None means no interface fitted, and '
          + 'sections C/D read open bus when a program pages it in. Shrinking '
          + 'discards whatever was in the pages that go away.'}
      >
        External RAM
      </span>
      <select
        value={settings.samExternalRam()}
        onChange={(event) => {
          const mb = Number((event.target as HTMLSelectElement).value);
          settings.setSamExternalRam(mb);
          settings.persistSetting('sam-external-ram', String(mb));
          // Live: the pages are allocated and re-paged on the spot, so no reset
          // is needed — though a program already running will not notice memory
          // appearing behind it.
          activeSam()?.memory.setExternalPages(samExternalPages(mb));
        }}
      >
        <For each={EXTERNAL_SIZES}>
          {(size) => <option value={size.mb}>{size.label}</option>}
        </For>
      </select>
    </div>
  );
}
