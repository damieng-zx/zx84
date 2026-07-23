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
  currentLocale, setCurrentLocale,
} from '@/state/machine-state.ts';
import type { MachineModel } from '@/models.ts';
import type { MachineLocale } from '@/machines/machine.ts';
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
  zx80: 'ZX80',
  zx81: 'ZX81',
  cpc464: 'CPC 464',
  cpc664: 'CPC 664',
  cpc6128: 'CPC 6128',
  cpc6128plus: 'CPC 6128 Plus',
  gx4000: 'GX4000',
  einstein: 'Einstein TC-01',
  'einstein-256': 'Einstein TC-01 256',
  'hx-10': 'Toshiba HX-10',
  mtx500: 'Memotech MTX500',
  mtx512: 'Memotech MTX512',
};

const LOCALE_LABELS: Record<MachineLocale, string> = {
  uk: 'English',
  es: 'Español',
  fr: 'Français',
};

/** Models that have locale-specific ROM variants, and which locales. */
const MODEL_LOCALES: Partial<Record<MachineModel, MachineLocale[]>> = {
  '48k': ['es'],
  '128k': ['fr', 'es'],
  '+2': ['fr', 'es'],
  '+2A': ['es'],
  '+3': ['es'],
  cpc464: ['fr', 'es'],
  cpc6128: ['fr'],
};

const FLAG_EMOJI: Record<MachineLocale, string> = {
  uk: '\uD83C\uDDEC\uD83C\uDDE7',
  es: '\uD83C\uDDEA\uD83C\uDDF8',
  fr: '\uD83C\uDDEB\uD83C\uDDF7',
};

/** Build a model menu entry. Models with locale variants get flag icons. */
function modelEntry(model: MachineModel): MenuItem {
  const variants = MODEL_LOCALES[model];
  if (!variants) return { value: model, label: MODEL_LABELS[model] };
  return {
    value: model,
    label: MODEL_LABELS[model],
    flags: variants.map(l => ({ locale: LOCALE_LABELS[l], emoji: FLAG_EMOJI[l], value: `${model}:${l}` })),
  };
}

// Model menu: Sinclair and Amstrad group their models behind submenus.
const MODEL_MENU: MenuItem[] = [
  {
    value: 'sinclair',
    label: 'Sinclair',
    children: [
      modelEntry('zx80'),
      modelEntry('zx81'),
      modelEntry('16k'),
      modelEntry('48k'),
      modelEntry('128k'),
      modelEntry('+2'),
      modelEntry('+2A'),
      modelEntry('+3'),
    ],
  },
  {
    value: 'amstrad',
    label: 'Amstrad',
    children: [
      modelEntry('cpc464'),
      modelEntry('cpc664'),
      modelEntry('cpc6128'),
      modelEntry('cpc6128plus'),
      modelEntry('gx4000'),
    ],
  },
  {
    value: 'tatung',
    label: 'Tatung',
    children: [
      modelEntry('einstein'),
    ],
  },
  {
    value: 'msx',
    label: 'MSX',
    children: [
      modelEntry('hx-10'),
    ],
  },
];

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
