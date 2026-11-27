/**
 * Acorn Atom descriptor — pure metadata plus the machine factory.
 *
 * Imported only by `registry.ts`; stays headless-safe (no solid-js, no reactive
 * state).
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities, SoundDeviceInfo,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { atomModelInfo, type AtomModel } from './models.ts';
import { AtomMachine } from './atom-machine.ts';
import { ATOM_TAPE_EXTENSIONS } from './atom-tape.ts';
import {
  ATOM_ACTIVE_HEIGHT, ATOM_ACTIVE_WIDTH, ATOM_BORDER_LEFT, ATOM_BORDER_TOP,
  ATOM_PIXEL_ASPECT_X, ATOM_SCREEN_HEIGHT, ATOM_SCREEN_WIDTH,
} from './constants.ts';

const SPEAKER: SoundDeviceInfo = { id: 'beeper', label: 'Speaker', volumeSetting: 'beeper-volume' };

const ATOM_UI: MachineUiCapabilities = {
  hiddenPanes: [
    'microdrive-panel', 'mouse-panel', 'sysvar-panel', 'font-panel', 'banks-panel',
    'drive-panel', 'joystick-panel',
  ],
  memoryLayout: false,
  trace: true,
  traceModes: ['full', 'portio'],
  // The colour-board palette is fixed; there is no brightness/colour-map choice.
  accuracy: false,
  builtinDisk: false,
  joystick: false,
  fixedJoystick: false,
  mouseTypes: [],
  cartridge: false,
  systemRomLabel: 'System ROM',
  romPages: 0,
  beeper: true,
  soundDevices: [SPEAKER],
  psgControls: [],
  statusLeds: ['kbd', 'text', 'beep', 'ear', 'load'],
  keyboardBus: 'ppi',
  tape: 'deck',
  tapeSound: false,
  tapeExtensions: [...ATOM_TAPE_EXTENSIONS],
  saveMenu: ['screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: false,
  library: false,
  memoryRegions: [],
  charset: 'bbc',
  memoryMappedIo: true,
};

export function atomDescriptor(
  model: MachineModel,
  _locale: MachineLocale = 'uk',
): MachineDescriptor {
  return {
    kind: 'atom',
    model,
    locale: 'uk',
    cpuFamily: 'm6502',
    screen: {
      width: ATOM_SCREEN_WIDTH,
      height: ATOM_SCREEN_HEIGHT,
      pixelAspectX: ATOM_PIXEL_ASPECT_X,
      activeWidth: ATOM_ACTIVE_WIDTH,
      activeHeight: ATOM_ACTIVE_HEIGHT,
      borderLeft: ATOM_BORDER_LEFT,
      borderTop: ATOM_BORDER_TOP,
    },
    ui: { ...ATOM_UI, systemRomLabel: atomModelInfo(model).romLabel },
  };
}

/** The reset vector of a kernel image at `offset`, or -1 when it cannot be
 *  read from a short image. */
function resetVector(data: Uint8Array, offset: number): number {
  if (offset + 0xFFE > data.length) return -1;
  return data[offset + 0xFFC] | (data[offset + 0xFFD] << 8);
}

export const atomEntry = {
  kind: 'atom',
  models: ['atom'] as const,
  descriptor: atomDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new AtomMachine(model as AtomModel, display);
  },
  romSources(model: MachineModel) {
    return atomModelInfo(model).romSources;
  },
  /** A standard 12 KB (BASIC + FP + kernel) or MAME-layout 16 KB image, or a
   *  bare 4 KB kernel, whose reset vector points into the kernel window. */
  detectModelForRom(data: Uint8Array, _current: MachineModel): MachineModel | null {
    if (data.length === 0x3000 && resetVector(data, 0x2000) >= 0xF000) return 'atom';
    if (data.length === 0x4000 && resetVector(data, 0x3000) >= 0xF000) return 'atom';
    if (data.length === 0x1000 && resetVector(data, 0) >= 0xF000) return 'atom';
    return null;
  },
} satisfies MachineEntry;
