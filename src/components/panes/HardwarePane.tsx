import { Pane } from '@/components/Pane.tsx';
import { HiOutlinePower } from 'solid-icons/hi';
import {
  currentModel, romStatusText, switchModel,
  turboMode, clockSpeedText, resetMachine, toggleTurbo,
  spectrum, triggerNMI, loadMultifaceROM, loadVTX5000ROM, loadPlusDROM, setCpcMultiface,
  multifaceRomFailed, vtx5000RomFailed, paradosRomFailed, plusDRomFailed,
} from '@/emulator.ts';
import type { SpectrumModel } from '@/spectrum.ts';
import { type MachineModel, isCpcModel, cpcHasDisk, isPlusDCapable } from '@/models.ts';
import { Show } from 'solid-js';
import { variantForModel, variantLabel } from '@/peripherals/multiface.ts';
import * as settings from '@/store/settings.ts';
import { resetSettingsGroup } from '@/store/settings.ts';

export function HardwarePane() {
  return (
    <Pane id="hardware-panel" label="Hardware" onResetSettings={() => {
      resetSettingsGroup('hardware');
      if (spectrum) spectrum.multiface.enabled = false;
      setCpcMultiface(false);
    }}>
      <div id="model-row">
        <select
          id="model"
          value={currentModel()}
          onChange={(e) => {
            switchModel((e.target as HTMLSelectElement).value as MachineModel);
            (e.target as HTMLSelectElement).blur();
          }}
        >
          <option value="16k">ZX Spectrum 16K</option>
          <option value="48k">ZX Spectrum 48K</option>
          <option value="128k">ZX Spectrum 128K</option>
          <option value="+2">ZX Spectrum +2</option>
          <option value="+2A">ZX Spectrum +2A</option>
          <option value="+3">ZX Spectrum +3</option>
          <option value="cpc464">Amstrad CPC 464</option>
          <option value="cpc664">Amstrad CPC 664</option>
          <option value="cpc6128">Amstrad CPC 6128</option>
        </select>
        <button
          id="cpu-mhz"
          title={turboMode() ? 'Switch to normal speed' : 'Toggle turbo speed'}
          class={`btn btn-md${turboMode() ? ' active' : ''}`}
          onClick={toggleTurbo}
        >{clockSpeedText()}</button>
        <button id="cpu-reset" title="Reset machine" onClick={resetMachine}><HiOutlinePower /></button>
      </div>
      <div class="hw-options">
      {/* Multiface and VTX-5000 are Spectrum-only peripherals. */}
      <Show when={!isCpcModel(currentModel())}>
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
                  if (spectrum) {
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
      </Show>
      {/* Multiface Two — CPC freeze/toolkit cartridge with red STOP (NMI). */}
      <Show when={isCpcModel(currentModel())}>
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
      </Show>
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
      <Show when={currentModel() === '+3'}>
        <div class="multiface-row">
          <label class="mf-check">
            <input
              type="checkbox"
              checked={settings.plus3V41Roms()}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                settings.setPlus3V41Roms(on);
                settings.persistSetting('plus3-v41-roms', on ? 'on' : 'off');
                switchModel('+3');
              }}
            />
            V4.1 ROMs
          </label>
        </div>
      </Show>
      </div>
      <Show when={romStatusText()}>
        <span class="rom-status" id="rom-status">{romStatusText()}</span>
      </Show>
    </Pane>
  );
}
