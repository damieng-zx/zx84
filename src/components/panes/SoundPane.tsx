import { Pane } from '@/components/Pane.tsx';
import { Show } from 'solid-js';
import {
  volume, setVolume,
  ayMix, setAyMix,
  ayStereo, setAyStereo,
  ayDcBlock, setAyDcBlock,
  ayAntialias, setAyAntialias,
  persistSetting, resetSettingsGroup,
} from '@/store/settings.ts';
import { machine, currentModel, applyDisplaySettings } from '@/emulator.ts';
import { isCpcModel } from '@/models.ts';
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
  { value: 'mute',    label: 'Filter' },
  { value: 'box',     label: 'Box filter' },
  { value: 'lowpass', label: 'Low-pass' },
  { value: 'none',    label: 'None (raw)' },
];

export function SoundPane() {
  return (
    <Pane id="sound-panel" label="Sound" onResetSettings={() => {
      resetSettingsGroup('sound');
      if (machine) {
        machine.ay.setStereoMode('ABC');
        machine.ay.dcBlocking = true;
        machine.ay.antialias = 'mute';
      }
      applyDisplaySettings();
    }}>
      <div class="slider-row">
        <span class="slider-label">Volume</span>
        <input
          type="range" id="volume-slider" min="0" max="100"
          value={volume()}
          onInput={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            setVolume(v);
            persistSetting('volume', v);
            applyDisplaySettings();
          }}
        />
        <span class="slider-value" id="volume-value">{volume()}</span>
      </div>
      {/* Beeper↔AY balance — Spectrum only; the CPC has no beeper. */}
      <Show when={!isCpcModel(currentModel())}>
        <div class="slider-row">
          <span class="slider-label">Mixer</span>
          <span class="slider-end-label">Beep</span>
          <input
            type="range" id="ay-mix-slider" min="0" max="100"
            value={ayMix()}
            onInput={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              setAyMix(v);
              persistSetting('ay-mix', v);
              applyDisplaySettings();
            }}
          />
          <span class="slider-end-label">AY</span>
        </div>
      </Show>
      <div class="slider-row">
        <span class="slider-label">AY Channels</span>
        <select
          id="ay-stereo-select"
          value={ayStereo()}
          onChange={(e) => {
            const mode = (e.target as HTMLSelectElement).value as AYStereoMode;
            setAyStereo(mode);
            if (machine) machine.ay.setStereoMode(mode);
            persistSetting('ay-stereo', mode);
          }}
        >
          {STEREO_MODES.map(m => <option value={m.value}>{m.label}</option>)}
        </select>
      </div>
      <div class="slider-row">
        <span class="slider-label">Anti-alias</span>
        <select
          id="ay-antialias-select"
          value={ayAntialias()}
          onChange={(e) => {
            const mode = (e.target as HTMLSelectElement).value as AYAntialiasMode;
            setAyAntialias(mode);
            if (machine) machine.ay.antialias = mode;
            persistSetting('ay-antialias', mode);
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
              if (machine) machine.ay.dcBlocking = on;
              persistSetting('ay-dc-block', on ? 'on' : 'off');
            }}
          />
        </label>
      </div>
    </Pane>
  );
}
