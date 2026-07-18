/**
 * CPC-specific Hardware-pane options: the Multiface Two freeze cartridge and the
 * ParaDOS AMSDOS-replacement toggle. Contributed to the generic Hardware pane
 * via the UI manifest (`src/components/machine-ui.ts`).
 */

import { Show } from 'solid-js';
import {
  currentModel, switchModel, setCpcMultiface, triggerNMI,
  multifaceRomFailed, paradosRomFailed,
} from '@/emulator.ts';
import { cpcHasDisk } from '@/machines/cpc/models.ts';
import * as settings from '@/store/settings.ts';

export function CpcHardwareSection() {
  return (
    <>
      {/* Multiface Two — CPC freeze/toolkit cartridge with red STOP (NMI). */}
      <div class="multiface-row">
        <label
          class={`mf-check${multifaceRomFailed() ? ' rom-failed' : ''}`}
          title={multifaceRomFailed() || undefined}
        >
          <input
            type="checkbox"
            checked={settings.multifaceEnabled()}
            disabled={!!multifaceRomFailed()}
            onChange={(e) => {
              const on = (e.target as HTMLInputElement).checked;
              settings.setMultifaceEnabled(on);
              settings.persistSetting('multiface', on ? 'on' : 'off');
              setCpcMultiface(on);
            }}
          />
          Multiface Two
        </label>
        <Show when={settings.multifaceEnabled()}>
          <button
            class="mf-trigger"
            title="Press the red STOP button (NMI)"
            aria-label="Press the Multiface STOP button"
            onClick={triggerNMI}
          />
        </Show>
      </div>
      {/* ParaDOS — AMSDOS replacement, disk-capable CPCs (664/6128) only. */}
      <Show when={cpcHasDisk(currentModel())}>
        <div class="multiface-row">
          <label
            class={`mf-check${paradosRomFailed() ? ' rom-failed' : ''}`}
            title={paradosRomFailed() || 'Use ParaDOS instead of AMSDOS in ROM 7'}
          >
            <input
              type="checkbox"
              checked={settings.cpcParados()}
              disabled={!!paradosRomFailed()}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                settings.setCpcParados(on);
                settings.persistSetting('cpc-parados', on ? 'on' : 'off');
                switchModel(currentModel());   // rebuild with/without the ParaDOS overlay
              }}
            />
            ParaDOS
          </label>
        </div>
      </Show>
    </>
  );
}
