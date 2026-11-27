import { Show, For, Switch, Match } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import {
  scale, setScale, scalingMode, setScalingMode,
  borderSize, setBorderSize,
  renderer, webglAvailable, scanlineAccuracy, setScanlineAccuracy,
  persistSetting, resetSettingsGroup,
} from '@/store/settings.ts';
import { machine } from '@/shell/context.ts';
import { switchRenderer } from '@/shell/media.ts';
import { applyDisplaySettings, buildSettingsView } from '@/shell/settings.ts';
import { machineCaps } from '@/state/machine-caps.ts';
import { SCALING_MODE_SAA5050 } from '@/display/scaling-modes.ts';

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
  { mode: SCALING_MODE_SAA5050, label: 'SAA5050 rounding', nativeScale: 0 },  // any scale
];

/**
 * The Color-map drop-down, drawn entirely from the machine's declaration
 * (`MachineUiCapabilities.colorMapChoice`): the setting it persists to and the
 * choices in display order. The pane never learns which family it is rendering,
 * so a machine adds a palette choice by declaring it, not by editing this file.
 */
function ColorMapSelect() {
  const choice = () => machineCaps().colorMapChoice!;
  const options = () => {
    const opts = choice().options;
    return typeof opts === 'function' ? opts() : opts;
  };
  // The stored value, falling back to the first option when it names a choice
  // this model does not offer (the Atari's stored tint on a PAL machine).
  const stored = () => {
    const view = buildSettingsView();
    const key = choice().setting;
    const current = view.get<string>(key, options()[0]?.value ?? '');
    return options().some(o => o.value === current) ? current : options()[0]?.value ?? '';
  };
  return (
    <select
      value={stored()}
      title={options().find(o => o.value === stored())?.title}
      onChange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        persistSetting(choice().setting, v);
        applyDisplaySettings();
      }}
    >
      <For each={options()}>
        {(o) => <option value={o.value} title={o.title}>{o.label}</option>}
      </For>
    </select>
  );
}

export function DisplayPane() {
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
      <Show when={machineCaps().colorMapChoice}>
      <div class="slider-row">
        <span class="slider-label">Color map</span>
        <ColorMapSelect />
      </div>
      </Show>
      <Show when={machineCaps().accuracy}>
      <div class="slider-row">
        <span class="slider-label">Accuracy</span>
        <select value={scanlineAccuracy()} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value as 'high' | 'mid' | 'low';
          setScanlineAccuracy(v);
          persistSetting('scanline-accuracy', v);
          applyDisplaySettings();   // machine re-reads its accuracy setting
        }}>
          <Switch fallback={<>
            <option value="high">High (per t-state)</option>
            <option value="mid">Mid (per scanline)</option>
            <option value="low">Low (per 8-scanlines/cell)</option>
          </>}>
            <Match when={machineCaps().accuracy === 'raster'}>
              <option value="high">High (per cycle)</option>
              <option value="mid">Mid (per scanline)</option>
              <option value="low">Low (per frame)</option>
            </Match>
            <Match when={machineCaps().accuracy === 'contention'}>
              <option value="high">High (ASIC memory slots)</option>
              <option value="low">Low (uncontended)</option>
            </Match>
          </Switch>
        </select>
      </div>
      </Show>
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
          // Machines that supply the raw source for this upscaler need to know.
          applyDisplaySettings();
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
