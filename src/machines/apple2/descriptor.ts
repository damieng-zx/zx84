/**
 * Apple II family descriptor — pure metadata plus the machine factory.
 *
 * Imported only by `registry.ts`; stays headless-safe (no solid-js, no reactive
 * state).
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { apple2ModelInfo, type Apple2Model } from './models.ts';
import { Apple2Machine } from './apple2-machine.ts';
import {
  APPLE2_ACTIVE_HEIGHT, APPLE2_ACTIVE_WIDTH, APPLE2_BORDER_LEFT, APPLE2_BORDER_TOP,
  APPLE2_PIXEL_ASPECT_X, APPLE2_SCREEN_HEIGHT, APPLE2_SCREEN_WIDTH,
} from './constants.ts';

const APPLE2_UI: MachineUiCapabilities = {
  hiddenPanes: [
    'microdrive-panel', 'mouse-panel', 'sysvar-panel',
    'font-panel', 'banks-panel', 'basic-panel', 'basic-vars-panel',
  ],
  memoryLayout: false,
  trace: false,
  colorMap: 'apple2',
  accuracy: false,
  builtinDisk: true,
  builtinDrives: 2,
  joystick: true,
  fixedJoystick: true,
  mouseTypes: [],
  cartridge: false,
  systemRomLabel: 'System ROM',
  romPages: 0,
  beeper: true,
  psgControls: [],
  statusLeds: ['kbd', 'dsk', 'beep', 'text'],
  keyboardBus: 'matrix',
  tape: 'deck',
  tapeSound: false,
  tapeExtensions: ['.wav'],
  saveMenu: ['screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: true,
  bootDisk: false,
  library: false,
  memoryRegions: [],
  charset: 'apple2',
};

export function apple2Descriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  return {
    kind: 'apple2',
    model,
    locale,
    cpuFamily: 'm6502',
    screen: {
      width: APPLE2_SCREEN_WIDTH,
      height: APPLE2_SCREEN_HEIGHT,
      pixelAspectX: APPLE2_PIXEL_ASPECT_X,
      activeWidth: APPLE2_ACTIVE_WIDTH,
      activeHeight: APPLE2_ACTIVE_HEIGHT,
      borderLeft: APPLE2_BORDER_LEFT,
      borderTop: APPLE2_BORDER_TOP,
    },
    ui: { ...APPLE2_UI, systemRomLabel: apple2ModelInfo(model).romLabel },
  };
}

export const apple2Entry: MachineEntry = {
  kind: 'apple2',
  models: ['apple2', 'apple2-plus', 'apple2e', 'apple2e-enhanced', 'apple2c'],
  descriptor: apple2Descriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new Apple2Machine(model as Apple2Model, display);
  },
  romSources(model: MachineModel) {
    return [apple2ModelInfo(model).romSource];
  },
};
