import { Show, For, Switch, Match } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import {
  scale, setScale, scalingMode, setScalingMode,
  borderSize, setBorderSize,
  renderer, webglAvailable, colorMap, setColorMap, scanlineAccuracy, setScanlineAccuracy,
  cpcColorMap, setCpcColorMap, msxColorMap, setMsxColorMap,
  einsteinColorMap, setEinsteinColorMap,
  persistSetting, resetSettingsGroup,
} from '@/store/settings.ts';
import { spectrum, machine, currentModel, switchRenderer, applyDisplaySettings } from '@/emulator.ts';
import { isCpcModel, isMsxModel, isEinsteinModel } from '@/models.ts';

// Scaling algorithms and their native scale factors.
// The algorithm IS the scaler — it takes 1x source pixels and produces
// NxN output blocks directly.  Only algorithms matching the current
// display scale are shown in the dropdown.
const SCALING_ALGOS: { mode: number; label: string; nativeScale: number }[] = [
  { mode: 0,  label: 'None',            nativeScale: 0 },  // 0 = any scale
  { mode: 1,  label: 'HQ2x',            nativeScale: 2 },
  { mode: 2,  label: 'HQ3x',            nativeScale: 3 },
  { mode: 3,  label: 'HQ4x',            nativeScale: 4 },
  { mode: 4,  label: 'xBR-lv2',         nativeScale: 0 },  // any scale
  { mode: 5,  label: 'xBR-lv3',         nativeScale: 0 },  // any scale
];

export function DisplayPane() {
  const isCpc = () => isCpcModel(currentModel());
  const isMsx = () => isMsxModel(currentModel());
  const isEinstein = () => isEinsteinModel(currentModel());
  // Filter algorithms to those compatible with the current display scale
  const availableAlgos = () => SCALING_ALGOS.filter(
    a => a.nativeScale === 0 || a.nativeScale === scale()
  );

  return (
    <Pane id="display-pane" label="Display" onResetSettings={() => { resetSettingsGroup('display'); applyDisplaySettings(); }}>
      <div id="display-controls">
        <label>
          Scale
          <select id="scale" value={scale()} onChange={(e) => {
            const v = Number((e.target as HTMLSelectElement).value);
            setScale(v);
            if (machine) machine.display!.setScale(v);
            persistSetting('scale', v);
            // Reset scaling algorithm if it doesn't match the new scale
            const cur = scalingMode();
            const algo = SCALING_ALGOS.find(a => a.mode === cur);
            if (algo && algo.nativeScale !== 0 && algo.nativeScale !== v) {
              setScalingMode(0);
              if (machine) machine.display!.setScalingMode(0);
              persistSetting('scaling-mode', 0);
            }
          }}>
            <option value="1">1x</option>
            <option value="2">2x</option>
            <option value="3">3x</option>
            <option value="4">4x</option>
          </select>
        </label>
        <label>
          Border
          <select id="border-size" value={borderSize()} onChange={(e) => {
            const v = Number((e.target as HTMLSelectElement).value) as 0 | 1 | 2;
            setBorderSize(v);
            if (machine) machine.setBorderSize(v);
            persistSetting('border-size', v);
            (e.target as HTMLSelectElement).blur();
          }}>
            <option value="2">Normal</option>
            <option value="1">Small</option>
            <option value="0">None</option>
          </select>
        </label>
      </div>
      <div class="slider-row">
        <span class="slider-label">Color map</span>
        <Switch
          fallback={
            <select value={colorMap()} onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value as 'basic' | 'measured' | 'vivid';
              setColorMap(v);
              persistSetting('color-map', v);
              applyDisplaySettings();
            }}>
              <option value="basic">Basic</option>
              <option value="measured">Measured</option>
              <option value="vivid">Vivid</option>
            </select>
          }
        >
          <Match when={isCpc()}>
            <select value={cpcColorMap()} onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value as 'basic' | 'gate-array' | 'asic';
              setCpcColorMap(v);
              persistSetting('cpc-color-map', v);
              applyDisplaySettings();
            }}>
              <option value="basic">Basic</option>
              <option value="gate-array">Gate Array</option>
              <option value="asic">ASIC</option>
            </select>
          </Match>
          <Match when={isMsx()}>
            <select value={msxColorMap()} onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value as 'pal' | 'ntsc';
              setMsxColorMap(v);
              persistSetting('msx-color-map', v);
              applyDisplaySettings();
            }}>
              <option value="pal">PAL</option>
              <option value="ntsc">NTSC</option>
            </select>
          </Match>
          <Match when={isEinstein()}>
            <select value={einsteinColorMap()} onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value as 'mame' | 'accurate' | 'naive';
              setEinsteinColorMap(v);
              persistSetting('einstein-color-map', v);
              applyDisplaySettings();
            }}>
              <option value="mame">MAME</option>
              <option value="accurate">Accurate</option>
              <option value="naive">Naive</option>
            </select>
          </Match>
        </Switch>
      </div>
      <div class="slider-row">
        <span class="slider-label">Accuracy</span>
        <select value={scanlineAccuracy()} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value as 'high' | 'mid' | 'low';
          setScanlineAccuracy(v);
          persistSetting('scanline-accuracy', v);
          if (spectrum) spectrum.scanlineAccuracy = v;
        }}>
          <option value="high">High (per t-state)</option>
          <option value="mid">Mid (per scanline)</option>
          <option value="low">Low (per 8-scanlines/cell)</option>
        </select>
      </div>
      <div class="slider-row">
        <span class="slider-label">Renderer</span>
        <select id="renderer-select" value={renderer()} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value as 'webgl' | 'canvas';
          switchRenderer(v);
        }}>
          <option value="webgl" disabled={!webglAvailable()}>
            WebGL{webglAvailable() ? '' : ' (unavailable)'}
          </option>
          <option value="canvas">Canvas</option>
        </select>
      </div>
      <Show when={renderer() === 'webgl'}>
      <div class="slider-row">
        <span class="slider-label">Upscaler</span>
        <select id="scaling-mode-select" value={scalingMode()} onChange={(e) => {
          const v = Number((e.target as HTMLSelectElement).value);
          setScalingMode(v);
          if (machine) machine.display!.setScalingMode(v);
          persistSetting('scaling-mode', v);
        }}>
          <For each={availableAlgos()}>
            {(a) => <option value={a.mode}>{a.label}</option>}
          </For>
        </select>
      </div>
      </Show>
    </Pane>
  );
}
