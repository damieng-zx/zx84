/**
 * Einstein registry entry — pure metadata + factory (re-architecture §3.5).
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/display.ts';
import type { MachineDescriptor, MachineEntry, MachineUiCapabilities } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { EinsteinModel } from './models.ts';
import { EinsteinMachine } from './einstein-machine.ts';
import {
  EINSTEIN_SCREEN_WIDTH, EINSTEIN_SCREEN_HEIGHT, EINSTEIN_BORDER_LEFT, EINSTEIN_BORDER_TOP,
} from './constants.ts';

const EINSTEIN_UI: MachineUiCapabilities = {
  hiddenPanes: [],
  memoryLayout: false,
  trace: true,
  colorMap: 'einstein',
  builtinDisk: true,
  joystick: false,
  fixedJoystick: false,
  mouse: false,
  cartridge: false,
  systemRomLabel: 'ROM',
  romPages: 0,
  beeper: true,
  kempston: true,
  tapeEar: true,
  rainbow: true,
  keyboardBus: 'ula',
  tape: 'deck',
  tapeSound: true,
  tapeExtensions: ['.tap', '.tzx', '.csw', '.zip'],
  saveMenu: 'vdp',
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: true,
  library: false,
  memoryRegions: [{ value: 'rom0', label: 'ROM 0' }],
  charset: 'spectrum',
};

/** Descriptor for the Einstein — shared by the registry entry and the machine
 *  instance's own `descriptor` getter. */
export function einsteinDescriptor(model: MachineModel): MachineDescriptor {
  return {
    kind: 'einstein',
    model,
    cpuFamily: 'z80',
    screen: {
      width: EINSTEIN_SCREEN_WIDTH, height: EINSTEIN_SCREEN_HEIGHT, pixelAspectX: 1,
      activeWidth: 256, activeHeight: 192,
      borderLeft: EINSTEIN_BORDER_LEFT, borderTop: EINSTEIN_BORDER_TOP,
    },
    ui: EINSTEIN_UI,
  };
}

export const einsteinEntry: MachineEntry = {
  kind: 'einstein',
  models: ['einstein'],
  descriptor: einsteinDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new EinsteinMachine(model as EinsteinModel, display);
  },
  romSources() {
    return ['einstein-mos.rom'];
  },
};
