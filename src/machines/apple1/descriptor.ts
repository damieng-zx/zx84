/**
 * Apple I descriptor — pure metadata plus the machine factory.
 *
 * Imported only by `registry.ts`; stays headless-safe (no solid-js, no reactive
 * state).
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { apple1ModelInfo, type Apple1Model } from './models.ts';
import { Apple1Machine } from './apple1-machine.ts';
import {
  APPLE1_ACTIVE_HEIGHT, APPLE1_ACTIVE_WIDTH, APPLE1_BORDER_LEFT, APPLE1_BORDER_TOP,
  APPLE1_PIXEL_ASPECT_X, APPLE1_ROM_SIZE, APPLE1_SCREEN_HEIGHT, APPLE1_SCREEN_WIDTH,
} from './constants.ts';

const APPLE1_UI: MachineUiCapabilities = {
  hiddenPanes: [
    'microdrive-panel', 'mouse-panel', 'sysvar-panel',
    'font-panel', 'banks-panel', 'basic-panel', 'basic-vars-panel',
  ],
  memoryLayout: false,
  trace: true,
  traceModes: ['full', 'portio'],
  colorMap: 'mono',
  accuracy: false,
  builtinDisk: false,
  joystick: false,
  fixedJoystick: false,
  mouseTypes: [],
  cartridge: false,
  systemRomLabel: 'System ROM',
  romPages: 0,
  beeper: false,
  psgControls: [],
  statusLeds: ['kbd', 'text'],
  keyboardBus: 'matrix',
  tape: 'deck',
  tapeSound: false,
  tapeExtensions: ['.wav'],
  // 'tape-tap' downloads what the machine has written to its cassette output (.wav).
  saveMenu: ['snapshot-a1state', 'tape-tap', 'screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: false,
  library: false,
  memoryRegions: [],
  charset: 'apple2',
  memoryMappedIo: true,
};

export function apple1Descriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  return {
    kind: 'apple1',
    model,
    locale,
    cpuFamily: 'm6502',
    screen: {
      width: APPLE1_SCREEN_WIDTH,
      height: APPLE1_SCREEN_HEIGHT,
      pixelAspectX: APPLE1_PIXEL_ASPECT_X,
      activeWidth: APPLE1_ACTIVE_WIDTH,
      activeHeight: APPLE1_ACTIVE_HEIGHT,
      borderLeft: APPLE1_BORDER_LEFT,
      borderTop: APPLE1_BORDER_TOP,
    },
    ui: { ...APPLE1_UI, systemRomLabel: apple1ModelInfo(model).romLabel },
  };
}

export const apple1Entry: MachineEntry = {
  kind: 'apple1',
  models: ['apple1'],
  descriptor: apple1Descriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new Apple1Machine(model as Apple1Model, display);
  },
  romSources(model: MachineModel) {
    return [apple1ModelInfo(model).romSource];
  },
  /** A bare 256-byte image is the Woz Monitor PROM. */
  detectModelForRom(data: Uint8Array): MachineModel | null {
    return data.length === APPLE1_ROM_SIZE ? 'apple1' : null;
  },
};
