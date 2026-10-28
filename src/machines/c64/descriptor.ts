/**
 * Commodore 64 descriptor — pure metadata plus the machine factory.
 *
 * Imported only by `registry.ts`; stays headless-safe (no solid-js, no
 * reactive state).
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { C64_ROM_SOURCES, type C64Model } from './models.ts';
import { C64Machine } from './c64-machine.ts';
import { C64_JOY_PORT1, C64_JOY_PORT2 } from './services/input.ts';
import {
  C64_ACTIVE_HEIGHT, C64_ACTIVE_WIDTH, C64_BORDER_LEFT, C64_BORDER_TOP, C64_KERNAL_SIZE,
  C64_ROM_SIZE, C64_SCREEN_HEIGHT, C64_SCREEN_WIDTH,
} from './constants.ts';

const C64_UI: MachineUiCapabilities = {
  hiddenPanes: [
    'microdrive-panel', 'mouse-panel', 'sysvar-panel', 'font-panel',
    'basic-panel', 'basic-vars-panel',
  ],
  memoryLayout: true,
  trace: true,
  traceModes: ['full', 'portio'],
  // The VIC-II's sixteen colours are fixed (palette.ts).
  colorMap: 'mono',
  accuracy: false,
  builtinDisk: false,
  // Two control ports on CIA 1; each player picks the port its stick is in.
  joystick: true,
  fixedJoystick: false,
  joystickTypes: [
    { id: C64_JOY_PORT2, label: 'Control port 2' },
    { id: C64_JOY_PORT1, label: 'Control port 1' },
  ],
  joystickFireButtons: 1,
  mouseTypes: [],
  cartridge: false,
  systemRomLabel: 'BASIC + KERNAL + characters',
  romPages: 0,
  beeper: false,
  soundChip: 'SID',
  psgControls: [],
  statusLeds: ['kbd', 'load', 'chip'],
  keyboardBus: 'matrix',
  tape: 'deck',
  tapeSound: false,
  tapeExtensions: ['.tap', '.t64', '.prg', '.zip'],
  // 'tape-tap' downloads what the KERNAL has SAVEd to tape (as a C64 .tap).
  saveMenu: ['snapshot-c64state', 'tape-tap', 'screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: false,
  library: false,
  memoryRegions: [
    { value: 'rom-basic', label: 'BASIC ROM' },
    { value: 'rom-kernal', label: 'KERNAL ROM' },
    { value: 'rom-chargen', label: 'Character ROM' },
    { value: 'color-ram', label: 'Colour RAM' },
  ],
  charset: 'spectrum',
  memoryMappedIo: true,
};

export function c64Descriptor(model: MachineModel, locale: MachineLocale = 'uk'): MachineDescriptor {
  return {
    kind: 'c64',
    model,
    locale,
    cpuFamily: 'm6502',
    screen: {
      width: C64_SCREEN_WIDTH,
      height: C64_SCREEN_HEIGHT,
      pixelAspectX: 1,
      activeWidth: C64_ACTIVE_WIDTH,
      activeHeight: C64_ACTIVE_HEIGHT,
      borderLeft: C64_BORDER_LEFT,
      borderTop: C64_BORDER_TOP,
    },
    ui: C64_UI,
  };
}

export const c64Entry: MachineEntry = {
  kind: 'c64',
  models: ['c64'],
  descriptor: c64Descriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new C64Machine(model as C64Model, display);
  },
  romSources() {
    return [...C64_ROM_SOURCES];
  },
  /** The three ROMs end to end (20K) are a 64's system ROM. An 8K KERNAL on
   *  its own is too, but so is many another 8K ROM, so only when already a 64. */
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    if (data.length === C64_ROM_SIZE) return 'c64';
    if (data.length === C64_KERNAL_SIZE && current === 'c64') return 'c64';
    return null;
  },
};
