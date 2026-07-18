import { Pane } from '@/ui/components/Pane.tsx';
import { SliderRow } from '@/ui/components/Slider.tsx';
import { Show } from 'solid-js';
import {
  volume, setVolume,
  ayMix, setAyMix,
  ayStereo, setAyStereo,
  ayDcBlock, setAyDcBlock,
  ayAntialias, setAyAntialias,
  persistSetting, resetSettingsGroup,
} from '@/store/settings.ts';
import { applyDisplaySettings } from '@/shell/settings.ts';
import { machineCaps } from '@/state/machine-caps.ts';
import type { AYStereoMode, AYAntialiasMode } from '@/cores/ay-3-8910.ts';

const STEREO_MODES: { value: AYStereoMode; label: string }[] = [
  { value: 'MONO', label: 'Mono' },
  { value: 'ABC',  label: 'Stereo ABC' },
  { value: 'ACB',  label: 'Stereo ACB' },
  { value: 'BAC',  label: 'Stereo BAC' },
  { value: 'BCA',  label: 'Stereo BCA' },
  { value: 'CAB',  label: 'Stereo CAB' },
  { value: 'CBA',  label: 'Stereo CBA' },
];

// Anti-alias strategy for ultrasonic AY tones (see AYAntialiasMode).
const ANTIALIAS_MODES: { value: AYAntialiasMode; label: string }[] = [
  { value: 'mute',    label: 'Mute ultrasonic' },
  { value: 'box',     label: 'Box filter' },
  { value: 'lowpass', label: 'Low-pass' },
  { value: 'none',    label: 'None (raw)' },
];

export function SoundPane() {
  return (
    <Pane id="sound-panel" label="Sound" onResetSettings={() => {
      resetSettingsGroup('sound');
      // Re-pump: the machine re-reads its AY settings from the store view.
      applyDisplaySettings();
    }}>
      <SliderRow label="Volume" id="volume" min={0} max={100} value={volume}
        onInput={(v) => { setVolume(v); persistSetting('volume', v); applyDisplaySettings(); }} />
      {/* Beeper↔AY balance — machines with a 1-bit beeper; the CPC has none. */}
      <Show when={machineCaps().beeper}>
        <SliderRow label="Mixer" id="ay-mix" min={0} max={100} value={ayMix} endLabels={['Beep', 'AY']}
          onInput={(v) => { setAyMix(v); persistSetting('ay-mix', v); applyDisplaySettings(); }} />
      </Show>
      <div class="slider-row">
        <span class="slider-label">AY Channels</span>
        <select
          id="ay-stereo-select"
          value={ayStereo()}
          onChange={(e) => {
            const mode = (e.target as HTMLSelectElement).value as AYStereoMode;
            setAyStereo(mode);
            persistSetting('ay-stereo', mode);
            applyDisplaySettings();
          }}
        >
          {STEREO_MODES.map(m => <option value={m.value}>{m.label}</option>)}
        </select>
      </div>
      <div class="slider-row">
        <span class="slider-label">Filter</span>
        <select
          id="ay-antialias-select"
          value={ayAntialias()}
          onChange={(e) => {
            const mode = (e.target as HTMLSelectElement).value as AYAntialiasMode;
            setAyAntialias(mode);
            persistSetting('ay-antialias', mode);
            applyDisplaySettings();
          }}
        >
          {ANTIALIAS_MODES.map(m => <option value={m.value}>{m.label}</option>)}
        </select>
      </div>
      <div class="slider-row">
        <span class="slider-label">DC Blocking</span>
        <label class="toggle">
          <input
            type="checkbox"
            id="ay-dc-block"
            checked={ayDcBlock()}
            onChange={(e) => {
              const on = (e.target as HTMLInputElement).checked;
              setAyDcBlock(on);
              persistSetting('ay-dc-block', on ? 'on' : 'off');
              applyDisplaySettings();
            }}
          />
        </label>
      </div>
    </Pane>
  );
}
