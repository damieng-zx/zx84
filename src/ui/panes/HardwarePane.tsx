import { Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { SliderRow } from '@/ui/components/Slider.tsx';
import { HiOutlinePower } from 'solid-icons/hi';
import {
  switchModel, resetMachine, setEmulationSpeed, SPEED_LABELS,
} from '@/shell/lifecycle.ts';
import { applyDisplaySettings } from '@/shell/settings.ts';
import {
  currentModel, romStatusText, speedStep, clockSpeedText,
} from '@/state/machine-state.ts';
import type { MachineModel } from '@/models.ts';
import { resetSettingsGroup } from '@/store/settings.ts';
import { machineUi } from '@/ui/machine-ui.ts';
import { machineKind } from '@/state/machine-caps.ts';

export function HardwarePane() {
  const speedValue = () => {
    const stop = SPEED_LABELS[speedStep()];
    const mhz = clockSpeedText();
    const actual = mhz === 'Max' ? (stop === 'max' ? '' : 'max') : `${mhz}MHz`;
    return <>
      <span class="speed-stop">{stop}</span>
      <Show when={actual}><span class="speed-mhz">{actual}</span></Show>
    </>;
  };

  return (
    <Pane id="hardware-panel" label="Hardware" onResetSettings={() => {
      setEmulationSpeed(4);
      resetSettingsGroup('hardware');
      // Re-pump so the machine applies the defaults (each machine's
      // applySettings live-disables peripherals whose setting is now off).
      applyDisplaySettings();
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
          <option value="zx80">Sinclair ZX80</option>
          <option value="zx81">Sinclair ZX81</option>
          <option value="cpc464">Amstrad CPC 464</option>
          <option value="cpc664">Amstrad CPC 664</option>
          <option value="cpc6128">Amstrad CPC 6128</option>
          <option value="cpc6128plus">Amstrad CPC 6128Plus</option>
          <option value="gx4000">Amstrad GX4000</option>
          <option value="einstein">Tatung Einstein TC-01</option>
          <option value="hx-10">MSX</option>
        </select>
        <button id="cpu-reset" title="Reset machine" onClick={resetMachine}><HiOutlinePower /></button>
      </div>
      <SliderRow
        label="Speed" id="speed" min={0} max={SPEED_LABELS.length - 1}
        class="speed-slider-row"
        value={speedStep} stops={SPEED_LABELS.map((_, index) => index)}
        valueText={(value) => SPEED_LABELS[value]}
        format={speedValue}
        onInput={setEmulationSpeed}
      />
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
