import { Pane } from '@/components/Pane.tsx';
import {
  volume, setVolume,
  ayMix, setAyMix,
  ayStereo, setAyStereo,
  ayDcBlock, setAyDcBlock,
  persistSetting, resetSettingsGroup,
} from '@/store/settings.ts';
import { spectrum, applyDisplaySettings } from '@/emulator.ts';
import type { AYStereoMode } from '@/cores/ay-3-8910.ts';

const STEREO_MODES: { value: AYStereoMode; label: string }[] = [
  { value: 'MONO', label: 'Mono' },
  { value: 'ABC',  label: 'Stereo ABC' },
  { value: 'ACB',  label: 'Stereo ACB' },
  { value: 'BAC',  label: 'Stereo BAC' },
  { value: 'BCA',  label: 'Stereo BCA' },
  { value: 'CAB',  label: 'Stereo CAB' },
  { value: 'CBA',  label: 'Stereo CBA' },
];

export function SoundPane() {
  return (
    <Pane id="sound-panel" label="Sound" onResetSettings={() => {
      resetSettingsGroup('sound');
      if (spectrum) {
        spectrum['audio'].setVolume(70 / 100);
        spectrum.ay.setStereoMode('ABC');
        spectrum.ay.dcBlocking = true;
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
            if (spectrum) spectrum['audio'].setVolume(v / 100);
            persistSetting('volume', v);
          }}
        />
        <span class="slider-value" id="volume-value">{volume()}</span>
      </div>
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
      <div class="slider-row">
        <span class="slider-label">AY Channels</span>
        <select
          id="ay-stereo-select"
          value={ayStereo()}
          onChange={(e) => {
            const mode = (e.target as HTMLSelectElement).value as AYStereoMode;
            setAyStereo(mode);
            if (spectrum) spectrum.ay.setStereoMode(mode);
            persistSetting('ay-stereo', mode);
          }}
        >
          {STEREO_MODES.map(m => <option value={m.value}>{m.label}</option>)}
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
              if (spectrum) spectrum.ay.dcBlocking = on;
              persistSetting('ay-dc-block', on ? 'on' : 'off');
            }}
          />
        </label>
      </div>
    </Pane>
  );
}
