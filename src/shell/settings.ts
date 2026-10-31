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
  'bbc-color-map': () => settings.bbcColorMap(),
  'apple2-video': () => settings.apple2Video(),
  'atari-color-map': () => settings.atariColorMap(),
  'scanline-accuracy': () => settings.scanlineAccuracy(),
  'volume': () => settings.volume(),
  'beeper-volume': () => settings.beeperVolume(),
  'psg-volume': () => settings.psgVolume(),
  'tape-instant-rom': () => settings.tapeFastRom(),
  'tape-turbo-load': () => settings.tapeTurbo(),
  'tape-sound': () => settings.tapeSoundEnabled(),
  'tape-auto-rewind': () => settings.tapeAutoRewind(),
  // AY/PSG shaping. Every machine carries an AY-family PSG except the MTX
  // (SN76489), which reuses these same keys — see Sn76489AntialiasMode.
  'ay-stereo': () => settings.ayStereo(),
  // The SN76489's tone-channel split (BBC Micro, MTX) — mono by default.
  'sn-stereo': () => settings.snStereo(),
  'ay-antialias': () => settings.ayAntialias(),
  'specdrum-volume': () => settings.specdrumVolume(),
  'uspeech-volume': () => settings.uspeechVolume(),
  'scc-volume': () => settings.sccVolume(),
  // Selected joystick interface per player (Spectrum: Kempston port fitted?).
  'joy-p1': () => settings.joyP1(),
  'joy-p2': () => settings.joyP2(),
  // Peripheral enablement + write-protects read by each machine's prepare() hook.
  'vtx5000': () => settings.vtx5000Enabled(),
  'specdrum': () => settings.specdrumEnabled(),
  'spectrum-issue2': () => settings.spectrumIssue2(),
  'multiface': () => settings.multifaceEnabled(),
  'plusd': () => settings.plusDEnabled(),
  'interface1': () => settings.interface1Enabled(),
  'betadisk': () => settings.betaDiskEnabled(),
  'uspeech': () => settings.uspeechEnabled(),
  'write-protect-a': () => settings.writeProtectA(),
  'write-protect-b': () => settings.writeProtectB(),
  'write-protect-c': () => settings.writeProtectC(),
  'write-protect-d': () => settings.writeProtectD(),
  'drive-b-force-ready': () => settings.driveBForceReady(),
  'einstein-xtaldos': () => settings.einsteinXtalDos(),
  'cpc-parados': () => settings.cpcParados(),
  'cpc-crtc-type': () => settings.cpcCrtcType(),
  'cpc-ram-expansion': () => settings.cpcRamExpansion(),
  'cpc-ddi1': () => settings.cpcDdi1(),
  'cpc-manufacturer': () => settings.cpcManufacturer(),
  'cpc-refresh': () => settings.cpcRefresh(),
  'mtx-cpm': () => settings.mtxCpm(),
  'mtx-80-column': () => settings.mtx80Column(),
  'mtx-512k-ram': () => settings.mtx512kRam(),
  'msx-floppy': () => settings.msxFloppy(),
  'bbc-disk-system': () => settings.bbcDiskSystem(),
  'electron-plus1': () => settings.electronPlus1(),
  'electron-plus3': () => settings.electronPlus3(),
  'electron-dfs': () => settings.electronDfs(),
  'apple2-disk2': () => settings.apple2Disk2(),
  'c64-drive': () => settings.c64Drive(),
  'c64-sid': () => settings.c64Sid(),
  'apple2-langcard': () => settings.apple2LangCard(),
  'apple2-joystick': () => settings.apple2Joystick(),
  'apple2-mockingboard': () => settings.apple2Mockingboard(),
  'apple2-80col': () => settings.apple2EightyCol(),
  'apple2e-80col': () => settings.apple2eEightyCol(),
  'apple1-ram': () => settings.apple1Ram(),
  'apple1-basic-ram': () => settings.apple1BasicRam(),
  'apple1-aci': () => settings.apple1Aci(),
  'enterprise-exdos': () => settings.enterpriseExdos(),
  'pcw-60hz': () => settings.pcw60Hz(),
  // True while the SAA5050 upscaler is selected: machines that draw teletext
  // then supply the raw, unrounded dots for it to round.
  'saa-scaler': () => settings.scalingMode() === SCALING_MODE_SAA5050,
  'zx8x-16k-ram': () => settings.zx8x16kRam(),
  'zx81-udg-ram': () => settings.zx81UdgRam(),
  'zx81-udg128-ram': () => settings.zx81Udg128Ram(),
  'zx81-wrx-hires': () => settings.zx81WrxHires(),
  'zx81-memotech-hrg': () => settings.zx81MemotechHrg(),
  'zx81-quicksilva-hrg': () => settings.zx81QuickSilvaHrg(),
  'zx81-zx-printer': () => settings.zx81ZxPrinter(),
  'zx81-chroma81': () => settings.zx81Chroma81(),
  'zx8x-zonx': () => settings.zx8xZonx(),
  'zx8x-vsync-sound': () => settings.zx8xVsyncSound(),
  'ace-ram-pack': () => settings.aceRamPack(),
};

/** Whether a boolean setting is on, reactively (call inside a tracking scope).
 *  Gates a machine capability on a user-fitted peripheral — see
 *  `MachineUiCapabilities.requires`. A missing gate is open. */
export function settingEnabled(key: string | undefined): boolean {
  if (!key) return true;
  const getter = SETTING_GETTERS[key];
  return getter ? Boolean(getter()) : true;
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
    d.setPhosphor(phosphorTint(settings.phosphor()));
  }
  // Machine-specific settings (palettes, volume, AY mix, tape flags, scanline
  // accuracy, …) are the machine's own business — it reads them from the view.
  machine.applySettings?.(buildSettingsView());
}
