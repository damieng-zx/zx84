/**
 * MSX registry entry — pure metadata + factory (re-architecture §3.5).
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type { MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { MsxModel } from './models.ts';
import { MsxMachine } from './msx-machine.ts';
import {
  MSX_SCREEN_WIDTH, MSX_SCREEN_HEIGHT, MSX_BORDER_LEFT, MSX_BORDER_TOP,
} from './constants.ts';

const MSX_UI: MachineUiCapabilities = {
  hiddenPanes: [],
  memoryLayout: true,
  trace: true,
  colorMap: 'msx',
  accuracy: false,
  builtinDisk: false,
  joystick: true,
  fixedJoystick: true,
  mouse: false,
  cartridge: true,
  systemRomLabel: 'System ROM',
  romPages: 0,
  beeper: true,
  psgControls: ['stereo', 'filter', 'dc-block'],
  // PSG (AY-3-8910) sound, cassette load, keyboard and OCR. The MSX has no
  // Spectrum-style EAR/rainbow/Kempston activity to indicate.
  statusLeds: ['kbd', 'load', 'ay', 'text'],
  keyboardBus: 'ula',
  tape: 'instant',
  tapeSound: true,
  tapeExtensions: ['.cas', '.zip'],
  saveMenu: 'vdp',
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: false,
  library: false,
  memoryRegions: [{ value: 'rom0', label: 'ROM 0' }],
  charset: 'spectrum',
};

/** Descriptor for the HX-10 — shared by the registry entry and the machine
 *  instance's own `descriptor` getter. */
export function msxDescriptor(model: MachineModel, locale: MachineLocale = 'uk'): MachineDescriptor {
  return {
    kind: 'msx',
    model,
    locale,
    cpuFamily: 'z80',
    screen: {
      width: MSX_SCREEN_WIDTH, height: MSX_SCREEN_HEIGHT, pixelAspectX: 1,
      activeWidth: 256, activeHeight: 192,
      borderLeft: MSX_BORDER_LEFT, borderTop: MSX_BORDER_TOP,
    },
    ui: MSX_UI,
  };
}

export const msxEntry: MachineEntry = {
  kind: 'msx',
  models: ['hx-10'],
  descriptor: msxDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new MsxMachine(model as MsxModel, display);
  },
  romSources(_model?: MachineModel, _locale?: MachineLocale) {
    return ['msx/hx-10_basic-bios1.rom'];
  },
};
