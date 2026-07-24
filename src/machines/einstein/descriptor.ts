/**
 * Einstein registry entry — pure metadata + factory (re-architecture §3.5).
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type { MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { isEinsteinModel, type EinsteinModel } from './models.ts';
import { EinsteinMachine } from './einstein-machine.ts';
import {
  EINSTEIN_SCREEN_WIDTH, EINSTEIN_SCREEN_HEIGHT, EINSTEIN_BORDER_LEFT, EINSTEIN_BORDER_TOP,
  EINSTEIN_256_SCREEN_WIDTH, EINSTEIN_256_SCREEN_HEIGHT,
  EINSTEIN_256_BORDER_LEFT, EINSTEIN_256_BORDER_TOP,
} from './constants.ts';

const EINSTEIN_UI: MachineUiCapabilities = {
  // The Einstein is disk-only: it has no cassette transport (the deck is inert,
  // no tape service, no tape port I/O — see services/index.ts + frame-probe.ts),
  // so the tape pane is hidden and no tape media is advertised.
  hiddenPanes: ['tape-panel'],
  memoryLayout: true,
  trace: true,
  colorMap: 'einstein',
  accuracy: false,
  builtinDisk: true,
  joystick: false,
  fixedJoystick: false,
  mouse: false,
  cartridge: false,
  systemRomLabel: 'ROM',
  romPages: 0,
  beeper: true,
  statusLeds: ['kbd', 'ay', 'dsk', 'text'],
  keyboardBus: 'ula',
  tapeSound: false,
  tapeExtensions: [],
  saveMenu: 'vdp',
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: true,
  library: false,
  memoryRegions: [{ value: 'rom0', label: 'ROM 0' }],
  charset: 'spectrum',
};

/** Descriptor for the Einstein — shared by the registry entry and the machine
 *  instance's own `descriptor` getter. Screen geometry is per-model: the
 *  TC-01's TMS9929A drives a 256×192 active area, the 256's V9938 a 512×212
 *  one. */
export function einsteinDescriptor(model: MachineModel, locale: MachineLocale = 'uk'): MachineDescriptor {
  const is256 = model === 'einstein-256';
  return {
    kind: 'einstein',
    model,
    locale,
    cpuFamily: 'z80',
    screen: is256
      ? {
        width: EINSTEIN_256_SCREEN_WIDTH, height: EINSTEIN_256_SCREEN_HEIGHT, pixelAspectX: 1,
        activeWidth: 512, activeHeight: 212,
        borderLeft: EINSTEIN_256_BORDER_LEFT, borderTop: EINSTEIN_256_BORDER_TOP,
      }
      : {
        width: EINSTEIN_SCREEN_WIDTH, height: EINSTEIN_SCREEN_HEIGHT, pixelAspectX: 1,
        activeWidth: 256, activeHeight: 192,
        borderLeft: EINSTEIN_BORDER_LEFT, borderTop: EINSTEIN_BORDER_TOP,
      },
    ui: EINSTEIN_UI,
  };
}

export const einsteinEntry: MachineEntry = {
  kind: 'einstein',
  models: ['einstein-tc01', 'einstein-256'],
  descriptor: einsteinDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new EinsteinMachine(model as EinsteinModel, display);
  },
  romSources(model: MachineModel, _locale?: MachineLocale) {
    return model === 'einstein-256'
      ? ['einstein/mos21.rom']
      : ['einstein/mos12.rom'];
  },
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    if (!isEinsteinModel(current)) return null;
    if (data.length === 0x4000) return 'einstein-256';
    if (data.length === 0x2000) return 'einstein-tc01';
    return null;
  },
};
