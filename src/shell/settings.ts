/**
 * Shell settings pump: pushes the persisted display/renderer settings (which the
 * shell owns, since it owns the `display`) into the active machine's renderer,
 * and hands each machine a read-only `SettingsView` so it can apply the settings
 * it cares about (palettes, volume, tape flags, …) via `applySettings`.
 */

import type { SettingsView } from '@/machines/machine.ts';
import * as settings from '@/store/settings.ts';
import { SCALING_MODE_SAA5050 } from '@/display/scaling-modes.ts';
import { phosphorTint } from '@/display/phosphor.ts';
import { machine } from '@/shell/context.ts';

/**
 * The settings a machine can read through its `SettingsView`, keyed by the
 * store's persistence keys.
 *
 * The catalogue in `store/settings` is the only listing of those keys: a setting
 * exposes a `get` there if a machine may read it, and this view serves exactly
 * those. There is no second table here to drift out of step — the earlier
 * hand-kept copy silently answered `fallback` for a key nobody had added to it,
 * which shipped four dead Hardware-pane options before a test caught it.
 */

/** Derived facts a machine reads that are not persisted settings. */
function derivedSetting(key: string): unknown {
  // True while the SAA5050 upscaler is selected, so machines that draw teletext
  // can supply the raw, unrounded dots for it to round.
  if (key === 'saa-scaler') return settings.scalingMode() === SCALING_MODE_SAA5050;
  return undefined;
}

const DERIVED_KEYS = ['saa-scaler'] as const;

/** Prefix families the view answers in addition to the literal settings: the
 *  per-machine-kind saved drive setup. */
const KEY_PREFIXES = ['drive-count:', 'drive-models:'] as const;

/**
 * Whether the view can answer `key`. A key this rejects is served as its
 * fallback, which is how a Hardware-pane option silently stops reaching its
 * machine — see `tests/shell/settings-view.test.ts`.
 */
export function settingsViewKnows(key: string): boolean {
  return settings.hasSignal(key)
    || (DERIVED_KEYS as readonly string[]).includes(key)
    || KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** The value of a setting, read reactively (call inside a tracking scope). */
function readSetting(key: string): unknown {
  return settings.hasSignal(key) ? settings.settingValue(key) : derivedSetting(key);
}

/** Whether a boolean setting is on, reactively (call inside a tracking scope).
 *  Gates a machine capability on a user-fitted peripheral — see
 *  `MachineUiCapabilities.requires`. A missing gate is open. */
export function settingEnabled(key: string | undefined): boolean {
  if (!key) return true;
  return settingsViewKnows(key) ? Boolean(readSetting(key)) : true;
}

export function buildSettingsView(): SettingsView {
  return {
    get<T>(key: string, fallback: T): T {
      // `drive-count:<kind>` is the number of built-in drives saved for a
      // machine kind; the machine's own default stands until one is chosen.
      if (key.startsWith('drive-count:')) {
        return (settings.savedDriveCount(key.slice('drive-count:'.length)) ?? fallback) as T;
      }
      // `drive-models:<kind>` is the list of drive models set up for a
      // machine kind (one per drive).
      if (key.startsWith('drive-models:')) {
        return (settings.savedDriveModels(key.slice('drive-models:'.length)) ?? fallback) as T;
      }
      return settingsViewKnows(key) ? (readSetting(key) as T) : fallback;
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
    d.setPhosphor(phosphorTint(settings.phosphor()));
  }
  // Machine-specific settings (palettes, volume, AY mix, tape flags, scanline
  // accuracy, …) are the machine's own business — it reads them from the view.
  machine.applySettings?.(buildSettingsView());
}
