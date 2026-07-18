/**
 * CPC-specific Hardware-pane options: the Multiface Two freeze cartridge and the
 * ParaDOS AMSDOS-replacement toggle. Contributed to the generic Hardware pane
 * via the UI manifest (`src/ui/machine-ui.ts`).
 */

import { Show } from 'solid-js';
import { machine, setStatus } from '@/shell/context.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import { fulfillAuxRoms } from '@/shell/rom.ts';
import {
  currentModel, multifaceRomFailed, paradosRomFailed,
} from '@/state/machine-state.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { cpcHasDisk } from '@/machines/cpc/models.ts';
import * as settings from '@/store/settings.ts';

/** The active machine as a CPC (this file is CPC-owned; kind-narrowing to the
 *  folder's own machine is the sanctioned pattern for machine `ui/` files). */
function activeCpc(): CpcMachine | null {
  return machine && machine.kind === 'cpc' ? (machine as unknown as CpcMachine) : null;
}

/** Enable/disable the Multiface Two live (no machine rebuild). */
function setCpcMultiface(on: boolean): void {
  const cpc = activeCpc();
  if (!cpc) return;
  cpc.multiface.enabled = on;
  if (on) {
    cpc.seedMultifaceShadow();
    if (!cpc.multiface.romLoaded) {
      // Fire-and-forget: the ROM is paged only on the button press.
      void fulfillAuxRoms([cpc.multifaceAuxRom(false)]);
    }
  } else {
    cpc.multiface.pageOut(cpc.memory);
  }
}

/** Press the red STOP button (NMI). */
function triggerNMI(): void {
  const cpc = activeCpc();
  if (!cpc) return;
  const mf = cpc.multiface;
  if (!mf.enabled) { setStatus('Multiface not enabled'); return; }
  if (!mf.romLoaded) { setStatus('Multiface ROM not loaded'); return; }
  mf.pressButton(cpc.memory, cpc.cpu);
  setStatus('Multiface NMI triggered');
}

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
