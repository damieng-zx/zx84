/**
 * CPC-specific Hardware-pane options: the Multiface Two freeze cartridge, the
 * ParaDOS AMSDOS-replacement toggle, and the board's fit — CRTC type, RAM
 * expansion, the 464's DDI-1 disk interface and the PPI configuration links.
 * Contributed to the generic Hardware pane via the UI manifest
 * (`src/ui/machine-ui.ts`). The fit is read when the machine is built, so
 * changing it rebuilds the machine.
 */

import { For, Show } from 'solid-js';
import { machine, setStatus } from '@/shell/context.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import { fulfillAuxRoms } from '@/shell/rom.ts';
import {
  currentModel, multifaceRomFailed, paradosRomFailed,
} from '@/state/machine-state.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { cpcHasDisk } from '@/machines/cpc/models.ts';
import type { CpcModel } from '@/machines/cpc/models.ts';
import {
  CPC_CRTC_TYPES, CPC_MANUFACTURERS, CPC_RAM_EXPANSIONS, cpcTakesClassicOptions, cpcTakesDdi1,
} from '@/machines/cpc/options.ts';
import * as settings from '@/store/settings.ts';

const CRTC_LABELS: Record<number, { label: string; title: string }> = {
  0: { label: 'Type 0 (HD6845S)', title: 'Hitachi HD6845S / UMC UM6845' },
  1: { label: 'Type 1 (UM6845R)', title: 'UMC UM6845R: status register, fixed 16-line VSYNC' },
  2: { label: 'Type 2 (MC6845)', title: 'Motorola MC6845: fixed 16-line VSYNC' },
  3: { label: 'Type 3 (ASIC)', title: "AMS40489 behaviour, as in the cost-down 6128's Pre-ASIC (type 4)" },
};

/** Rebuild the machine so a build-time fit (CRTC, RAM, interface) applies. */
function rebuild(): void {
  void switchModel(currentModel());
}

/** One labelled select bound to a string setting that rebuilds the machine. */
function FitSelect(props: {
  label: string; title: string; key: string; value: string;
  set: (v: string) => void; options: readonly { value: string; label: string; title?: string }[];
}) {
  return (
    <div class="slider-row">
      <span class="slider-label" title={props.title}>{props.label}</span>
      <select
        value={props.value}
        onChange={(event) => {
          const value = (event.target as HTMLSelectElement).value;
          props.set(value);
          settings.persistSetting(props.key, value);
          rebuild();
        }}
      >
        <For each={props.options}>
          {option => <option value={option.value} title={option.title}>{option.label}</option>}
        </For>
      </select>
    </div>
  );
}

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
  const model = () => currentModel() as CpcModel;
  const ddi1 = () => cpcTakesDdi1(model()) && settings.cpcDdi1();
  return (
    <>
      <Show when={cpcTakesClassicOptions(model())}>
        <FitSelect
          label="CRTC"
          title={'Which 6845 CRTC is fitted. 464/664/6128s shipped with several, which differ in '
            + 'register read-back, the status register, VSYNC width and some raster edge cases. '
            + 'The machine rebuilds when this changes.'}
          key="cpc-crtc-type"
          value={settings.cpcCrtcType()}
          set={settings.setCpcCrtcType}
          options={CPC_CRTC_TYPES.map(t => ({ value: String(t), ...CRTC_LABELS[t] }))}
        />
        <FitSelect
          label="RAM expansion"
          title={"A Dk'tronics-compatible RAM expansion, banked in 64K blocks by the Gate Array "
            + 'RAM command. On a 6128 its first 64K is hidden by the internal RAM (320K / 576K in '
            + 'all). The machine rebuilds when this changes.'}
          key="cpc-ram-expansion"
          value={settings.cpcRamExpansion()}
          set={settings.setCpcRamExpansion}
          options={CPC_RAM_EXPANSIONS.map(kb => kb === 0
            ? { value: 'none', label: 'None' }
            : { value: `${kb}k`, label: `${kb}K` })}
        />
      </Show>
      <Show when={cpcTakesDdi1(model())}>
        <div class="multiface-row">
          <label
            class="mf-check"
            title="Fit the DDI-1 disk interface: a uPD765A with drives A: and B:, and AMSDOS in ROM 7"
          >
            <input
              type="checkbox"
              checked={settings.cpcDdi1()}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                settings.setCpcDdi1(on);
                settings.persistSetting('cpc-ddi1', on ? 'on' : 'off');
                rebuild();
              }}
            />
            DDI-1 disk interface
          </label>
        </div>
      </Show>
      <FitSelect
        label="Name links"
        title={'Links LK1-LK3 on the board, read through PPI port B: the distributor name the '
          + 'firmware shows when it starts. The machine rebuilds when this changes.'}
        key="cpc-manufacturer"
        value={settings.cpcManufacturer()}
        set={settings.setCpcManufacturer}
        options={CPC_MANUFACTURERS.map(m => ({ value: m.id, label: m.label }))}
      />
      <FitSelect
        label="Refresh link"
        title={'Link LK4, read through PPI port B: the firmware programs a 50 Hz or 60 Hz '
          + 'display from it. The machine rebuilds when this changes.'}
        key="cpc-refresh"
        value={settings.cpcRefresh()}
        set={settings.setCpcRefresh}
        options={[{ value: '50', label: '50 Hz' }, { value: '60', label: '60 Hz' }]}
      />
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
      <Show when={cpcHasDisk(currentModel()) || ddi1()}>
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
