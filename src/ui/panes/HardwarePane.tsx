import { Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { SliderRow } from '@/ui/components/Slider.tsx';
import { DropDownMenuButton, type MenuItem } from '@/ui/components/DropDownMenuButton.tsx';
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

// Full name shown on the model box once selected — keyed by model value.
const MODEL_LABELS: Record<MachineModel, string> = {
  '16k': 'ZX Spectrum 16K',
  '48k': 'ZX Spectrum 48K',
  '128k': 'ZX Spectrum 128K',
  '+2': 'ZX Spectrum +2',
  '+2A': 'ZX Spectrum +2A',
  '+3': 'ZX Spectrum +3',
  zx80: 'Sinclair ZX80',
  zx81: 'Sinclair ZX81',
  cpc464: 'Amstrad CPC 464',
  cpc664: 'Amstrad CPC 664',
  cpc6128: 'Amstrad CPC 6128',
  cpc6128plus: 'Amstrad CPC 6128Plus',
  gx4000: 'Amstrad GX4000',
  einstein: 'Tatung Einstein TC-01',
  'hx-10': 'MSX',
};

// Top-level model menu: Sinclair and Amstrad group their models behind a
// flyout submenu; Tatung and MSX stay as single top-level entries.
const MODEL_MENU: MenuItem[] = [
  {
    value: 'sinclair',
    label: 'Sinclair',
    children: [
      { value: 'zx80', label: 'ZX80' },
      { value: 'zx81', label: 'ZX81' },
      { value: '16k', label: 'ZX Spectrum 16K' },
      { value: '48k', label: 'ZX Spectrum 48K' },
      { value: '128k', label: 'ZX Spectrum 128K' },
      { value: '+2', label: 'ZX Spectrum +2' },
      { value: '+2A', label: 'ZX Spectrum +2A' },
      { value: '+3', label: 'ZX Spectrum +3' },
    ],
  },
  {
    value: 'amstrad',
    label: 'Amstrad',
    children: [
      { value: 'cpc464', label: 'CPC 464' },
      { value: 'cpc664', label: 'CPC 664' },
      { value: 'cpc6128', label: 'CPC 6128' },
      { value: 'cpc6128plus', label: 'CPC 6128Plus' },
      { value: 'gx4000', label: 'GX4000' },
    ],
  },
  { value: 'einstein', label: 'Tatung Einstein TC-01' },
  { value: 'hx-10', label: 'MSX' },
];

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
        <DropDownMenuButton
          label={MODEL_LABELS[currentModel()]}
          title="Select machine"
          items={MODEL_MENU}
          onSelect={(value) => switchModel(value as MachineModel)}
        />
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
