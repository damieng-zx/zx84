/**
 * Shell settings pump: pushes the persisted display/renderer settings (which the
 * shell owns, since it owns the `display`) into the active machine's renderer,
 * and hands each machine a read-only `SettingsView` so it can apply the settings
 * it cares about (palettes, volume, tape flags, …) via `applySettings`.
 */

import type { SettingsView } from '@/machines/machine.ts';
import * as settings from '@/store/settings.ts';
import { machine } from '@/shell/context.ts';

/**
 * A read-only view over the reactive settings store, keyed by the store's
 * persistence key strings. Machines read only the keys they care about; they
 * never import the reactive settings module. Values come straight from the
 * (already-coerced) signals so behaviour matches the pre-split direct reads.
 */
// Arrows (not bare signal references) so the store's exports are read only when
// a key is actually requested — a machine reads just its own keys, and test
// mocks that stub a subset of the store don't crash at module load.
const SETTING_GETTERS: Record<string, () => unknown> = {
  'color-map': () => settings.colorMap(),
  'cpc-color-map': () => settings.cpcColorMap(),
  'msx-color-map': () => settings.msxColorMap(),
  'einstein-color-map': () => settings.einsteinColorMap(),
  'scanline-accuracy': () => settings.scanlineAccuracy(),
  'volume': () => settings.volume(),
  'ay-mix': () => settings.ayMix(),
  'tape-instant-rom': () => settings.tapeFastRom(),
  'tape-turbo-load': () => settings.tapeTurbo(),
  'tape-sound': () => settings.tapeSoundEnabled(),
  'tape-auto-rewind': () => settings.tapeAutoRewind(),
  // AY/PSG shaping (all machines carry an AY-family PSG).
  'ay-stereo': () => settings.ayStereo(),
  'ay-dc-block': () => settings.ayDcBlock(),
  'ay-antialias': () => settings.ayAntialias(),
  // Peripheral enablement + write-protects read by each machine's prepare() hook.
  'vtx5000': () => settings.vtx5000Enabled(),
  'multiface': () => settings.multifaceEnabled(),
  'plusd': () => settings.plusDEnabled(),
  'interface1': () => settings.interface1Enabled(),
  'betadisk': () => settings.betaDiskEnabled(),
  'write-protect-a': () => settings.writeProtectA(),
  'write-protect-b': () => settings.writeProtectB(),
  'write-protect-c': () => settings.writeProtectC(),
  'write-protect-d': () => settings.writeProtectD(),
  'drive-b-force-ready': () => settings.driveBForceReady(),
  'cpc-parados': () => settings.cpcParados(),
  'mtx-80-column': () => settings.mtx80Column(),
  'zx8x-16k-ram': () => settings.zx8x16kRam(),
  'zx81-udg-ram': () => settings.zx81UdgRam(),
  'zx81-udg128-ram': () => settings.zx81Udg128Ram(),
  'zx81-wrx-hires': () => settings.zx81WrxHires(),
  'zx81-memotech-hrg': () => settings.zx81MemotechHrg(),
  'zx81-quicksilva-hrg': () => settings.zx81QuickSilvaHrg(),
};

export function buildSettingsView(): SettingsView {
  return {
    get<T>(key: string, fallback: T): T {
      const getter = SETTING_GETTERS[key];
      return getter ? (getter() as T) : fallback;
    },
  };
}

/**
 * Apply the shell-owned display/renderer settings to the active machine's
 * display, then push a SettingsView so the machine applies its own
 * (palette / volume / tape / scanline …) settings.
 */
export function applyDisplaySettings(): void {
  if (!machine) return;
  machine.setBorderSize(settings.borderSize() as 0 | 1 | 2);
  const d = machine.display;
  if (d) {
    d.setScale(settings.scale());
    d.setBrightness(settings.brightness() / 50);
    d.setContrast(settings.contrast() / 50);
    d.setSaturation(settings.saturation() / 50);
    d.setGamma(2 ** (settings.gamma() / 50));
    d.setSmoothing(settings.smoothing() / 100);
    d.setCurvature(settings.curvatureMode() < 0 ? 0 : settings.curvature() / 100 * 0.15);
    d.setScanlines(settings.scanlines() / 100);
    d.setMaskType(settings.maskType());
    d.setDotPitch(settings.dotPitch() / 10);
    d.setCurvatureMode(settings.curvatureMode());
    d.setNoise(settings.noise() / 100);
    d.setScalingMode(settings.scalingMode());
  }
  // Machine-specific settings (palettes, volume, AY mix, tape flags, scanline
  // accuracy, …) are the machine's own business — it reads them from the view.
  machine.applySettings?.(buildSettingsView());
}
