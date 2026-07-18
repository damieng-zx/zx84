import { Show } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { SliderRow } from '@/components/Slider.tsx';
import {
  brightness, setBrightness, contrast, setContrast,
  saturation, setSaturation, gamma, setGamma,
  smoothing, setSmoothing, curvature, setCurvature, scanlines, setScanlines,
  maskType, setMaskType, dotPitch, setDotPitch, curvatureMode, setCurvatureMode,
  noise, setNoise, scalingMode,
  monitor, setMonitor,
  renderer,
  persistSetting, resetSettingsGroup,
} from '@/store/settings.ts';
import { machine } from '@/shell/context.ts';
import { applyDisplaySettings } from '@/shell/settings.ts';

interface MonitorPreset {
  maskType: number;
  dotPitch: number;
  curvature: number;
  curvatureMode: number;
  scanlines: number;
  smoothing: number;
  noise: number;
  brightness?: number;
  contrast?: number;
}

const MONITOR_PRESETS: Record<string, MonitorPreset> = {
  'raw': { maskType: 0, dotPitch: 10, curvature: 0, curvatureMode: -1, scanlines: 0, smoothing: 0, noise: 0, brightness: 0, contrast: 50 },
  'lcd': { maskType: 4, dotPitch: 10, curvature: 0, curvatureMode: -1, scanlines: 0, smoothing: 0, noise: 0, brightness: 0, contrast: 50 },
  'microvitec-cub': { maskType: 1, dotPitch: 20, curvature: 70, curvatureMode: 0, scanlines: 50, smoothing: 20, noise: 8 },
  'philips-cm8833': { maskType: 3, dotPitch: 20, curvature: 50, curvatureMode: 0, scanlines: 45, smoothing: 40, noise: 10 },
  'commodore-1080': { maskType: 1, dotPitch: 10, curvature: 50, curvatureMode: 0, scanlines: 45, smoothing: 20, noise: 8 },
  'amstrad-cm14': { maskType: 1, dotPitch: 20, curvature: 70, curvatureMode: 0, scanlines: 50, smoothing: 60, noise: 15 },
  'sony-trinitron': { maskType: 2, dotPitch: 10, curvature: 45, curvatureMode: 1, scanlines: 30, smoothing: 20, noise: 5, brightness: -5, contrast: 55 },
  'atari-sc1224': { maskType: 1, dotPitch: 10, curvature: 40, curvatureMode: 0, scanlines: 45, smoothing: 40, noise: 10 },
  'cheap-tv': { maskType: 1, dotPitch: 15, curvature: 80, curvatureMode: 0, scanlines: 65, smoothing: 70, noise: 30, brightness: -5, contrast: 55 },
};

function applyPreset(preset: MonitorPreset) {
  setMaskType(preset.maskType); if (machine) machine.display!.setMaskType(preset.maskType); persistSetting('mask-type', preset.maskType);
  setDotPitch(preset.dotPitch); if (machine) machine.display!.setDotPitch(preset.dotPitch / 10); persistSetting('dot-pitch', preset.dotPitch);
  setCurvature(preset.curvature); if (machine) machine.display!.setCurvature(preset.curvature / 100 * 0.15); persistSetting('curvature', preset.curvature);
  setCurvatureMode(preset.curvatureMode); if (machine) machine.display!.setCurvatureMode(preset.curvatureMode); persistSetting('curvature-mode', preset.curvatureMode);
  setScanlines(preset.scanlines); if (machine) machine.display!.setScanlines(preset.scanlines / 100); persistSetting('scanlines', preset.scanlines);
  setSmoothing(preset.smoothing); if (machine) machine.display!.setSmoothing(preset.smoothing / 100); persistSetting('smoothing', preset.smoothing);
  setNoise(preset.noise); if (machine) machine.display!.setNoise(preset.noise / 100); persistSetting('noise', preset.noise);
  if (preset.brightness != null) { setBrightness(preset.brightness); if (machine) machine.display!.setBrightness(preset.brightness / 50); persistSetting('brightness', preset.brightness); }
  if (preset.contrast != null) { setContrast(preset.contrast); if (machine) machine.display!.setContrast(preset.contrast / 50); persistSetting('contrast', preset.contrast); }
}

export function MonitorPane() {
  return (
    <Pane id="monitor-pane" label="Monitor" onResetSettings={() => { resetSettingsGroup('monitor'); applyDisplaySettings(); }}>
      <Show when={renderer() === 'webgl'}>
      <SliderRow label="Brightness" id="brightness" min={-50} max={50} value={brightness}
        onInput={(v) => { setBrightness(v); machine?.display?.setBrightness(v / 50); persistSetting('brightness', v); }} />
      <SliderRow label="Contrast" id="contrast" min={0} max={100} value={contrast}
        onInput={(v) => { setContrast(v); machine?.display?.setContrast(v / 50); persistSetting('contrast', v); }} />
      <SliderRow label="Saturation" id="saturation" min={0} max={100} value={saturation}
        onInput={(v) => { setSaturation(v); machine?.display?.setSaturation(v / 50); persistSetting('saturation', v); }} />
      <SliderRow label="Gamma" id="gamma" min={-50} max={50} value={gamma}
        format={v => (2 ** (v / 50)).toFixed(2)}
        onInput={(v) => { setGamma(v); machine?.display?.setGamma(2 ** (v / 50)); persistSetting('gamma', v); }} />
      <div class="slider-row">
        <span class="slider-label">Monitor</span>
        <select id="monitor-select" value={monitor()} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          setMonitor(v);
          persistSetting('monitor', v);
          const preset = MONITOR_PRESETS[v];
          if (preset) applyPreset(preset);
        }}>
          <option value="raw">Raw</option>
          <option value="lcd">LCD</option>
          <option value="microvitec-cub">Microvitec CUB</option>
          <option value="philips-cm8833">Philips CM8833</option>
          <option value="commodore-1080">Commodore 1080</option>
          <option value="amstrad-cm14">Amstrad CM14</option>
          <option value="sony-trinitron">Sony PVM/Trinitron</option>
          <option value="atari-sc1224">Atari SC1224</option>
          <option value="cheap-tv">Cheap TV</option>
        </select>
      </div>
      <SliderRow label="Scanlines" id="scanlines" min={0} max={100} value={scanlines}
        onInput={(v) => { setScanlines(v); machine?.display?.setScanlines(v / 100); persistSetting('scanlines', v); }} />
      <Show when={scalingMode() === 0}>
      <SliderRow label="Softness" id="smoothing" min={0} max={100} value={smoothing}
        onInput={(v) => { setSmoothing(v); machine?.display?.setSmoothing(v / 100); persistSetting('smoothing', v); }} />
      </Show>
      <SliderRow label="Noise" id="noise" min={0} max={100} value={noise}
        onInput={(v) => { setNoise(v); machine?.display?.setNoise(v / 100); persistSetting('noise', v); }} />
      <div class="slider-row">
        <span class="slider-label">Curv. mode</span>
        <select id="curvature-mode-select" value={curvatureMode()} onChange={(e) => {
          const v = Number((e.target as HTMLSelectElement).value);
          setCurvatureMode(v);
          if (machine) {
            if (v < 0) machine.display!.setCurvature(0);
            else { machine.display!.setCurvatureMode(v); machine.display!.setCurvature(curvature() / 100 * 0.15); }
          }
          persistSetting('curvature-mode', v);
        }}>
          <option value="-1">None</option>
          <option value="0">Spherical</option>
          <option value="1">Cylindrical</option>
        </select>
      </div>
      <Show when={curvatureMode() >= 0}>
      <SliderRow label="Curvature" id="curvature" min={0} max={100} value={curvature}
        onInput={(v) => { setCurvature(v); machine?.display?.setCurvature(v / 100 * 0.15); persistSetting('curvature', v); }} />
      </Show>
      <div class="slider-row">
        <span class="slider-label">Mask type</span>
        <select id="mask-type-select" value={maskType()} onChange={(e) => {
          const v = Number((e.target as HTMLSelectElement).value);
          setMaskType(v);
          if (machine) machine.display!.setMaskType(v);
          persistSetting('mask-type', v);
        }}>
          <option value="0">None</option>
          <option value="1">Shadow Mask</option>
          <option value="2">Aperture Grille</option>
          <option value="3">Slot Mask</option>
          <option value="4">LCD Grid</option>
          <option value="5">Attr Mask</option>
        </select>
      </div>
      <Show when={maskType() !== 4 && maskType() !== 5 && maskType() !== 0}>
      <SliderRow label="Dot pitch" id="dot-pitch" min={10} max={40} value={dotPitch}
        onInput={(v) => { setDotPitch(v); machine?.display?.setDotPitch(v / 10); persistSetting('dot-pitch', v); }} />
      </Show>
      </Show>
    </Pane>
  );
}
