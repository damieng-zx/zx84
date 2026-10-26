import { Pane } from '@/ui/components/Pane.tsx';
import { SliderRow } from '@/ui/components/Slider.tsx';
import { For, Show } from 'solid-js';
import {
  volume, setVolume,
  ayStereo, setAyStereo,
  snStereo, setSnStereo,
  ayAntialias, setAyAntialias,
  micAudible, setMicAudible,
  persistSetting, resetSettingsGroup, DEVICE_VOLUMES,
} from '@/store/settings.ts';
import { applyDisplaySettings, settingEnabled } from '@/shell/settings.ts';
import { machineCaps } from '@/state/machine-caps.ts';
import { presentSoundDevices, soundDeviceMaxVolume } from '@/machines/machine.ts';
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

/** The sound devices to draw a volume slider for: all those fitted, but only when
 *  there are at least two. Reactive on the model and on the Hardware-pane toggles. */
function mixDevices() {
  const present = presentSoundDevices(machineCaps().soundDevices, settingEnabled);
  return present.length > 1 ? present : [];
}

export function SoundPane() {
  return (
    <Pane id="sound-panel" label="Sound" onResetSettings={() => {
      resetSettingsGroup('sound');
      // Re-pump: the machine re-reads its AY settings from the store view.
      applyDisplaySettings();
    }}>
      <SliderRow label="Volume" id="volume" min={0} max={100} value={volume}
        onInput={(v) => { setVolume(v); persistSetting('volume', v); applyDisplaySettings(); }} />
      {/* One volume slider per hardware sound device the descriptor lists and the
          machine actually has fitted — only once there are two or more to weigh
          against each other. A single-device machine keeps master volume alone. */}
      <For each={mixDevices()}>
        {(d) => {
          const vol = DEVICE_VOLUMES[d.volumeSetting];
          return (
            <Show when={vol}>
              <SliderRow label={d.label} id={d.volumeSetting} min={0} max={soundDeviceMaxVolume(d)} value={vol![0]}
                onInput={(v) => { vol![1](v); persistSetting(d.volumeSetting, v); applyDisplaySettings(); }} />
            </Show>
          );
        }}
      </For>
      {/* The MIC line leaks into the Spectrum speaker. Software that pulses it as a
          sync/trigger output (the SpecDrum's clock) then ticks; this hides it. */}
      <Show when={machineCaps().micSpeaker}>
        <div class="slider-row">
          <span class="slider-label">MIC in speaker</span>
          <label class="toggle">
            <input
              type="checkbox"
              id="mic-audible"
              checked={micAudible()}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                setMicAudible(on);
                persistSetting('mic-audible', on ? 'on' : 'off');
                applyDisplaySettings();
              }}
            />
          </label>
        </div>
      </Show>
      {/* All three below are AY-3-891x shaping; a machine lists the ones it
          actually reads, so nothing is offered that would do nothing. */}
      <Show when={machineCaps().psgControls.includes('stereo')}>
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
      </Show>
      {/* The SN76489 is mono on the real machines, so its split has its own
          setting (default Mono) rather than inheriting the AY's ABC. */}
      <Show when={machineCaps().psgControls.includes('sn-stereo')}>
      <div class="slider-row">
        <span class="slider-label">PSG Channels</span>
        <select
          id="sn-stereo-select"
          value={snStereo()}
          onChange={(e) => {
            const mode = (e.target as HTMLSelectElement).value;
            setSnStereo(mode);
            persistSetting('sn-stereo', mode);
            applyDisplaySettings();
          }}
        >
          {STEREO_MODES.map(m => <option value={m.value}>{m.label}</option>)}
        </select>
      </div>
      </Show>
      <Show when={machineCaps().psgControls.includes('filter')}>
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
      </Show>
    </Pane>
  );
}
