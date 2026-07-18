/**
 * Spectrum-specific Hardware-pane options: the Multiface, VTX-5000 modem, MGT
 * +D, ZX Interface 1 and Beta Disk toggles. Contributed to the generic Hardware
 * pane via the UI manifest (`src/components/machine-ui.ts`).
 *
 * A machine `ui/` file — the only Spectrum files allowed to import solid-js and
 * the shell/settings/state layers. It reaches its own peripherals directly
 * (same machine folder).
 */

import { Show } from 'solid-js';
import {
  currentModel, resetMachine, spectrum,
  multifaceRomFailed, vtx5000RomFailed, plusDRomFailed, interface1RomFailed, betaDiskRomFailed,
} from '@/emulator.ts';
import {
  loadMultifaceROM, loadVTX5000ROM, loadPlusDROM, loadInterface1ROM, loadBetaDiskROM, triggerNMI,
} from '@/machines/spectrum/ui/hardware-actions.ts';
import { isPlusDCapable, isInterface1Capable, isBetaDiskCapable, type SpectrumModel } from '@/machines/spectrum/models.ts';
import { variantForModel, variantLabel } from '@/machines/spectrum/peripherals/multiface.ts';
import * as settings from '@/store/settings.ts';

export function SpectrumHardwareSection() {
  return (
    <>
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
              if (spectrum) {
                spectrum.multiface.enabled = on;
                if (on && !spectrum.multiface.romLoaded) {
                  loadMultifaceROM(spectrum);
                }
              }
            }}
          />
          {variantLabel(variantForModel(currentModel() as SpectrumModel))}
        </label>
        <Show when={settings.multifaceEnabled()}>
          <button
            class="mf-trigger"
            title="Trigger NMI (Multiface button)"
            aria-label="Trigger Multiface NMI"
            onClick={triggerNMI}
          />
        </Show>
      </div>
      <div class="multiface-row">
        <label
          class={`mf-check${vtx5000RomFailed() ? ' rom-failed' : ''}`}
          title={vtx5000RomFailed() || undefined}
        >
          <input
            type="checkbox"
            checked={settings.vtx5000Enabled()}
            disabled={!!vtx5000RomFailed()}
            onChange={(e) => {
              const on = (e.target as HTMLInputElement).checked;
              settings.setVtx5000Enabled(on);
              settings.persistSetting('vtx5000', on ? 'on' : 'off');
              if (spectrum) {
                spectrum.vtx5000.enabled = on;
                if (on && !spectrum.vtx5000.romLoaded) {
                  loadVTX5000ROM(spectrum);
                }
              }
            }}
          />
          VTX-5000
        </label>
      </div>
      <Show when={isPlusDCapable(currentModel())}>
        <div class="multiface-row">
          <label
            class={`mf-check${plusDRomFailed() ? ' rom-failed' : ''}`}
            title={plusDRomFailed() || 'MGT +D disk interface (G+DOS, drives C:/D:)'}
          >
            <input
              type="checkbox"
              checked={settings.plusDEnabled()}
              disabled={!!plusDRomFailed()}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                settings.setPlusDEnabled(on);
                settings.persistSetting('plusd', on ? 'on' : 'off');
                if (on) {
                  settings.setBetaDiskEnabled(false);
                  settings.persistSetting('betadisk', 'off');
                }
                if (spectrum) {
                  if (on) spectrum.betaDisk.enabled = false;
                  spectrum.mgtPlusD.enabled = on;
                  // The +D boots at reset (shadow ROM pages in at 0x0000), so
                  // a reset is needed for the toggle to take effect.
                  if (on && !spectrum.mgtPlusD.romLoaded) {
                    loadPlusDROM(spectrum).then(() => resetMachine());
                  } else {
                    resetMachine();
                  }
                }
              }}
            />
            MGT +D
          </label>
        </div>
      </Show>
      <Show when={isInterface1Capable(currentModel())}>
        <div class="multiface-row">
          <label
            class="mf-check"
            title={interface1RomFailed() || 'ZX Interface 1 — shadow ROM + 8 microdrives'}
          >
            <input
              type="checkbox"
              checked={settings.interface1Enabled()}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                settings.setInterface1Enabled(on);
                settings.persistSetting('interface1', on ? 'on' : 'off');
                if (on) {
                  settings.setBetaDiskEnabled(false);
                  settings.persistSetting('betadisk', 'off');
                }
                if (spectrum) {
                  if (on) spectrum.betaDisk.enabled = false;
                  spectrum.interface1.enabled = on;
                  // The IF1 ROM initialises at reset (its M1 traps map it in),
                  // so a reset is needed for the toggle to take effect.
                  if (on && !spectrum.interface1.romLoaded) {
                    loadInterface1ROM(spectrum).then(() => resetMachine());
                  } else {
                    resetMachine();
                  }
                }
              }}
            />
            ZX Interface 1
          </label>
        </div>
      </Show>
      <Show when={isBetaDiskCapable(currentModel())}>
        <div class="multiface-row">
          <label
            class={`mf-check${betaDiskRomFailed() ? ' rom-failed' : ''}`}
            title={betaDiskRomFailed() || 'Beta Disk interface (TR-DOS, drives A:/B:)'}
          >
            <input
              type="checkbox"
              checked={settings.betaDiskEnabled()}
              disabled={!!betaDiskRomFailed()}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                settings.setBetaDiskEnabled(on);
                settings.persistSetting('betadisk', on ? 'on' : 'off');
                // Beta, +D and IF1 all overlay slot 0 — keep them exclusive.
                if (on) {
                  settings.setPlusDEnabled(false);
                  settings.persistSetting('plusd', 'off');
                  settings.setInterface1Enabled(false);
                  settings.persistSetting('interface1', 'off');
                }
                if (spectrum) {
                  if (on) { spectrum.mgtPlusD.enabled = false; spectrum.interface1.enabled = false; }
                  spectrum.betaDisk.enabled = on;
                  // TR-DOS maps itself in via the 0x3Dxx trap after reset.
                  if (on && !spectrum.betaDisk.romLoaded) {
                    loadBetaDiskROM(spectrum).then(() => resetMachine());
                  } else {
                    resetMachine();
                  }
                }
              }}
            />
            Beta Disk/TR-DOS
          </label>
        </div>
      </Show>
    </>
  );
}
