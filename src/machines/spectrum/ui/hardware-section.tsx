/**
 * Spectrum-specific Hardware-pane options: the 16K/48K board issue, and the
 * Multiface, VTX-5000 modem, MGT +D, ZX Interface 1 and Beta Disk toggles. Contributed to the generic Hardware
 * pane via the UI manifest (`src/ui/machine-ui.ts`).
 *
 * A machine `ui/` file — the only Spectrum files allowed to import solid-js and
 * the shell/settings/state layers. It reaches its own peripherals directly
 * (same machine folder).
 */

import { Show } from 'solid-js';
import { resetMachine } from '@/shell/lifecycle.ts';
import {
  currentModel,
  multifaceRomFailed, vtx5000RomFailed, plusDRomFailed, interface1RomFailed, betaDiskRomFailed, uspeechRomFailed,
} from '@/state/machine-state.ts';
import { activeSpectrum } from '@/machines/spectrum/ui/active.ts';
import {
  loadMultifaceROM, loadVTX5000ROM, loadPlusDROM, loadInterface1ROM, loadBetaDiskROM, loadUspeechROMs, triggerNMI,
} from '@/machines/spectrum/ui/hardware-actions.ts';
import {
  isPlusDCapable, isInterface1Capable, isUspeechCapable, isBetaDiskCapable, hasBuiltinBetaDisk, hasBoardIssueOption,
  type SpectrumModel,
} from '@/machines/spectrum/models.ts';
import { variantForModel, variantLabel } from '@/machines/spectrum/peripherals/multiface.ts';
import * as settings from '@/store/settings.ts';

export function SpectrumHardwareSection() {
  return (
    <>
      <Show when={hasBoardIssueOption(currentModel())}>
        <div class="slider-row">
          <span
            class="slider-label"
            title={'Which board the 16K/48K is built on. Port 0xFE bit 6 reads back the last OUT: '
              + 'on an Issue 1/2 board it follows bits 3 (MIC) and 4 (EAR), on an Issue 3 bit 4 alone. '
              + 'Some early games (Abu Simbel Profanation, Rasputin) only read the keyboard on Issue 2.'}
          >
            Board
          </span>
          <select
            value={settings.spectrumIssue2() ? 'issue2' : 'issue3'}
            onChange={(event) => {
              const on = (event.target as HTMLSelectElement).value === 'issue2';
              settings.setSpectrumIssue2(on);
              settings.persistSetting('spectrum-issue2', on ? 'on' : 'off');
              // A board fact read on every port-0xFE IN: no reset needed.
              activeSpectrum()?.setBoardIssue2(on);
            }}
          >
            <option value="issue2">Issue 1/2</option>
            <option value="issue3">Issue 3</option>
          </select>
        </div>
      </Show>
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
              const s = activeSpectrum();
              if (s) {
                s.multiface.enabled = on;
                if (on && !s.multiface.romLoaded) {
                  loadMultifaceROM(s);
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
              const s = activeSpectrum();
              if (s) {
                s.vtx5000.enabled = on;
                if (on && !s.vtx5000.romLoaded) {
                  loadVTX5000ROM(s);
                }
              }
            }}
          />
          VTX-5000
        </label>
      </div>
      <div class="multiface-row">
        <label class="mf-check" title="Cheetah SpecDrum — 8-bit DAC on port 0xDF (own volume slider in the Sound pane)">
          <input
            type="checkbox"
            checked={settings.specdrumEnabled()}
            onChange={(e) => {
              const on = (e.target as HTMLInputElement).checked;
              settings.setSpecdrumEnabled(on);
              settings.persistSetting('specdrum', on ? 'on' : 'off');
              const s = activeSpectrum();
              // No ROM and no reset needed: the board is just a port + DAC.
              if (s) s.setSpecdrumFitted(on);
            }}
          />
          SpecDrum
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
                const s = activeSpectrum();
                if (s) {
                  if (on) s.betaDisk.enabled = false;
                  s.mgtPlusD.enabled = on;
                  // The +D boots at reset (shadow ROM pages in at 0x0000), so
                  // a reset is needed for the toggle to take effect.
                  if (on && !s.mgtPlusD.romLoaded) {
                    loadPlusDROM(s).then(() => resetMachine());
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
                const s = activeSpectrum();
                if (s) {
                  if (on) s.betaDisk.enabled = false;
                  s.interface1.enabled = on;
                  // The IF1 ROM initialises at reset (its M1 traps map it in),
                  // so a reset is needed for the toggle to take effect.
                  if (on && !s.interface1.romLoaded) {
                    loadInterface1ROM(s).then(() => resetMachine());
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
      <Show when={isUspeechCapable(currentModel())}>
        <div class="multiface-row">
          <label
            class={`mf-check${uspeechRomFailed() ? ' rom-failed' : ''}`}
            title={uspeechRomFailed() || 'Currah µSpeech — SP0256-AL2 speech synthesiser (LET s$="…" in BASIC)'}
          >
            <input
              type="checkbox"
              checked={settings.uspeechEnabled()}
              disabled={!!uspeechRomFailed()}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                settings.setUspeechEnabled(on);
                settings.persistSetting('uspeech', on ? 'on' : 'off');
                const s = activeSpectrum();
                if (s) {
                  s.currah.enabled = on;
                  // The unit's ROM initialises BASIC's RAMTOP on the first interrupt
                  // after power-up, so fitting or removing it needs a reset.
                  if (on && !(s.currah.romLoaded && s.currah.speechRomLoaded)) {
                    loadUspeechROMs(s).then((ok) => { if (ok) resetMachine(); });
                  } else {
                    resetMachine();
                  }
                }
              }}
            />
            Currah µSpeech
          </label>
        </div>
      </Show>
      <Show when={isBetaDiskCapable(currentModel()) && !hasBuiltinBetaDisk(currentModel())}>
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
                const s = activeSpectrum();
                if (s) {
                  if (on) { s.mgtPlusD.enabled = false; s.interface1.enabled = false; }
                  s.betaDisk.enabled = on;
                  // TR-DOS maps itself in via the 0x3Dxx trap after reset.
                  if (on && !s.betaDisk.romLoaded) {
                    loadBetaDiskROM(s).then(() => resetMachine());
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
