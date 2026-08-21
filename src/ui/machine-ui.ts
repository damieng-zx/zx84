/**
 * UI-side machine manifest — maps a machine *kind* to the Solid components each
 * machine folder contributes to the otherwise machine-blind UI.
 *
 * This is the ONE file under `src/ui` allowed to import a concrete
 * machine folder (see the `ui-no-concrete-machines` dependency-cruiser rule).
 * Everything else in the UI reaches machine specifics through services, the
 * descriptor's `ui` capabilities (`@/state/machine-caps.ts`), or this manifest.
 *
 * Contributions are code-split (`lazy`) so a machine's UI bundle only loads when
 * that machine is selected — the registry itself stays headless (no solid-js).
 */

import { lazy, type Component } from 'solid-js';
import type { KeyboardLabPresetLoader } from './keyboard-lab/types.ts';

/** Per-machine UI contributions. Any field may be absent (the machine doesn't
 *  contribute that piece of UI); the generic host then renders nothing there. */
export interface MachineUiContribution {
  /** Machine-specific options block inside the Hardware pane. */
  readonly HardwareSection?: Component;
  /** On-screen keyboard overlay rendered beneath the screen. */
  readonly Keyboard?: Component;
  /** System-variables pane body. */
  readonly SysVars?: Component;
  /** Software-library browser. */
  readonly LibraryBrowser?: Component;
  /** Scan live RAM for character fonts into the shared font store (Fonts
   *  pane "Hunt"). Dynamically imported on first use, so the machine's
   *  bundle only loads when its Hunt actually runs. */
  readonly HuntFonts?: () => void;
}

const CONTRIBUTIONS: Record<string, MachineUiContribution> = {
  spectrum: {
    HardwareSection: lazy(() =>
      import('@/machines/spectrum/ui/hardware-section.tsx').then(m => ({ default: m.SpectrumHardwareSection }))),
    Keyboard: lazy(() =>
      import('@/machines/spectrum/ui/keyboard/KeyboardPane.tsx').then(m => ({ default: m.KeyboardPane }))),
    SysVars: lazy(() =>
      import('@/machines/spectrum/ui/SysVars.tsx').then(m => ({ default: m.SysVars }))),
    LibraryBrowser: lazy(() =>
      import('@/machines/spectrum/ui/LibraryBrowser.tsx').then(m => ({ default: m.LibraryBrowser }))),
    HuntFonts: () =>
      import('@/machines/spectrum/ui/font-hunt.ts').then(m => m.huntSpectrumFonts()),
  },
  cpc: {
    HardwareSection: lazy(() =>
      import('@/machines/cpc/ui/hardware-section.tsx').then(m => ({ default: m.CpcHardwareSection }))),
    Keyboard: lazy(() =>
      import('@/machines/cpc/ui/keyboard/KeyboardPane.tsx').then(m => ({ default: m.KeyboardPane }))),
  },
  einstein: {
    HardwareSection: lazy(() =>
      import('@/machines/einstein/ui/hardware-section.tsx').then(m => ({ default: m.EinsteinHardwareSection }))),
  },
  msx: {
    Keyboard: lazy(() =>
      import('@/machines/msx/ui/keyboard/KeyboardPane.tsx').then(m => ({ default: m.KeyboardPane }))),
  },
  mtx: {
    HardwareSection: lazy(() =>
      import('@/machines/mtx/ui/hardware-section.tsx').then(m => ({ default: m.MtxHardwareSection }))),
  },
  zx8x: {
    HardwareSection: lazy(() =>
      import('@/machines/zx8x/ui/hardware-section.tsx').then(m => ({ default: m.Zx8xHardwareSection }))),
    Keyboard: lazy(() =>
      import('@/machines/zx8x/ui/keyboard/KeyboardPane.tsx').then(m => ({ default: m.KeyboardPane }))),
    LibraryBrowser: lazy(() =>
      import('@/machines/zx8x/ui/LibraryBrowser.tsx').then(m => ({ default: m.Zx8xLibraryBrowser }))),
  },
};

/** The UI contributions for a machine kind (empty object when none registered). */
export function machineUi(kind: string): MachineUiContribution {
  return CONTRIBUTIONS[kind] ?? {};
}

/**
 * Development-only keyboard editor seeds. Keeping these adapters in this
 * manifest preserves the same concrete-machine import boundary as the runtime
 * UI contributions above.
 */
export const keyboardLabPresetLoaders: readonly KeyboardLabPresetLoader[] = [
  {
    group: 'Sinclair ZX Spectrum',
    load: () => import('@/machines/spectrum/ui/keyboard/lab-preset.ts')
      .then((module) => module.spectrumKeyboardLabPresets()),
  },
  {
    group: 'Sinclair ZX80/ZX81',
    load: () => import('@/machines/zx8x/ui/keyboard/lab-preset.ts')
      .then((module) => module.zx8xKeyboardLabPresets()),
  },
  {
    group: 'Amstrad CPC',
    load: () => import('@/machines/cpc/ui/keyboard/lab-preset.ts')
      .then((module) => module.cpcKeyboardLabPresets()),
  },
  {
    group: 'MSX',
    load: () => import('@/machines/msx/ui/keyboard/lab-preset.ts')
      .then((module) => module.hx10KeyboardLabPresets()),
  },
];
