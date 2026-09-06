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
import * as settings from '@/store/settings.ts';
import { SAM_MAX_EXTERNAL_MB } from '../constants.ts';
import { samExternalPages } from '../models.ts';
import { activeSam } from './active.ts';

/** The sizes the megabyte interface was sold in, plus "not fitted". */
const EXTERNAL_SIZES = Array.from(
  { length: SAM_MAX_EXTERNAL_MB + 1 },
  (_, mb) => ({ mb, label: mb === 0 ? 'None' : `${mb} MB` }),
);

export function SamHardwareSection() {
  return (
    <>
    <div class="slider-row">
      <span
        class="slider-label"
        title={'MGT mouse plugged into the DIN port. It is read through the '
          + 'keyboard port with no row selected, so an empty socket is a '
          + 'different read from a still mouse — unplug it if a program '
          + 'mistakes the mouse stream for keypresses.'}
      >
        Mouse
      </span>
      <label class="toggle">
        <input
          type="checkbox"
          id="sam-mouse"
          checked={settings.samMouse()}
          onChange={(event) => {
            const on = (event.target as HTMLInputElement).checked;
            settings.setSamMouse(on);
            settings.persistSetting('sam-mouse', on ? 'on' : 'off');
            // Live: plugging the mouse in or out changes only what the next
            // read of &FFFE answers, so no reset is needed.
            const sam = activeSam();
            if (sam) { sam.mouse.enabled = on; sam.mouse.reset(); }
          }}
        />
      </label>
    </div>
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
    </>
  );
}
