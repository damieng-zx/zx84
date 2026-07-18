import { Show } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { HiOutlinePower } from 'solid-icons/hi';
import {
  currentModel, romStatusText, switchModel,
  turboMode, clockSpeedText, resetMachine, toggleTurbo,
  spectrum, setCpcMultiface,
} from '@/emulator.ts';
import type { MachineModel } from '@/models.ts';
import { resetSettingsGroup } from '@/store/settings.ts';
import { machineUi } from '@/components/machine-ui.ts';
import { machineKind } from '@/state/machine-caps.ts';

export function HardwarePane() {
  return (
    <Pane id="hardware-panel" label="Hardware" onResetSettings={() => {
      resetSettingsGroup('hardware');
      // Machine-specific peripheral cleanup, via the shell handle (no machine
      // import): disable the Spectrum Multiface and the CPC Multiface Two.
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
          <option value="einstein">Tatung Einstein TC-01</option>
          <option value="hx-10">Toshiba HX-10 (MSX)</option>
        </select>
        <button
          id="cpu-mhz"
          title={turboMode() ? 'Switch to normal speed' : 'Toggle turbo speed'}
          class={`btn btn-md${turboMode() ? ' active' : ''}`}
          onClick={toggleTurbo}
        >{clockSpeedText()}<Show when={clockSpeedText() !== 'Turbo' && !clockSpeedText().endsWith('×')}><span class="cpu-mhz-unit">MHz</span></Show></button>
        <button id="cpu-reset" title="Reset machine" onClick={resetMachine}><HiOutlinePower /></button>
      </div>
      <div class="hw-options">
        {/* Machine-specific hardware options, contributed per machine kind. */}
        <Show when={machineUi(machineKind()).HardwareSection} keyed>
          {(Section) => <Section />}
        </Show>
      </div>
      <Show when={romStatusText()}>
        <span class="rom-status" id="rom-status">{romStatusText()}</span>
      </Show>
    </Pane>
  );
}
