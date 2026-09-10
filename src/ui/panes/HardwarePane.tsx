import { Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { SliderRow } from '@/ui/components/Slider.tsx';
import { DropDownMenuButton } from '@/ui/components/DropDownMenuButton.tsx';
import { HiOutlinePower } from 'solid-icons/hi';
import {
  switchModel, resetMachine, setEmulationSpeed, SPEED_LABELS,
} from '@/shell/lifecycle.ts';
import { applyDisplaySettings } from '@/shell/settings.ts';
import {
  currentModel, romStatusText, speedStep, clockSpeedText,
  currentLocale, setCurrentLocale,
} from '@/state/machine-state.ts';
import type { MachineModel } from '@/models.ts';
import type { MachineLocale } from '@/machines/machine.ts';
import { resetSettingsGroup } from '@/store/settings.ts';
import { machineUi } from '@/ui/machine-ui.ts';
import { machineKind } from '@/state/machine-caps.ts';
import {
  LOCALE_LABELS, MODEL_LABELS, MODEL_LOCALES, MODEL_MENU,
} from '@/ui/panes/model-menu.ts';

function selectModel(value: string) {
  const colon = value.indexOf(':');
  if (colon === -1) {
    setCurrentLocale('uk');
    switchModel(value as MachineModel);
  } else {
    const model = value.substring(0, colon) as MachineModel;
    const locale = value.substring(colon + 1) as MachineLocale;
    setCurrentLocale(locale);
    switchModel(model);
  }
}

function buttonLabel() {
  const model = currentModel();
  const locale = currentLocale();
  const base = MODEL_LABELS[model];
  if (locale === 'uk' || !MODEL_LOCALES[model]?.includes(locale)) return base;
  return `${base} (${LOCALE_LABELS[locale]})`;
}

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
          label={buttonLabel()}
          title="Select machine"
          items={MODEL_MENU}
          onSelect={selectModel}
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
