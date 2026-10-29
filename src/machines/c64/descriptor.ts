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
import { C64_JOY_PORT1, C64_JOY_PORT2, C64_MOUSE_PORT1, C64_MOUSE_PORT2 } from './services/input.ts';
import {
  C64_ACTIVE_HEIGHT, C64_ACTIVE_WIDTH, C64_BORDER_LEFT, C64_KERNAL_SIZE,
  C64_ROM_SIZE, C64_SCREEN_WIDTH, c64Timing,
} from './constants.ts';

const C64_UI: MachineUiCapabilities = {
  hiddenPanes: ['microdrive-panel', 'sysvar-panel', 'font-panel'],
  memoryLayout: true,
  trace: true,
  traceModes: ['full', 'portio'],
  // The VIC-II's sixteen colours are fixed (palette.ts).
  colorMap: 'mono',
  accuracy: false,
  // The drive is on the serial bus; the Hardware pane plugs it in or out.
  builtinDisk: true,
  requires: { builtinDisk: 'c64-drive' },
  builtinDrives: 4,
  builtinDriveLabels: ['Drive 8', 'Drive 9', 'Drive 10', 'Drive 11'],
  // Up to four drives, devices 8 to 11, each a 1541 or a 1581: the Drives pane's
  // "..." menu adds and removes them and picks each one's model.
  driveModels: [
    { value: '1541', label: '1541', title: '5.25" GCR disks: .d64, .g64' },
    { value: '1581', label: '1581', title: '3.5" 800K disks: .d81' },
  ],
  defaultDriveModels: ['1541'],
  // Two control ports on CIA 1; each player picks the port its stick is in.
  // Player 1 starts in port 1 and player 2 in port 2 (the Nth type is the
  // Nth player's default, see JoystickPane).
  joystick: true,
  fixedJoystick: false,
  joystickTypes: [
    { id: C64_JOY_PORT1, label: 'Control port 1' },
    { id: C64_JOY_PORT2, label: 'Control port 2' },
  ],
  joystickFireButtons: 1,
  // A 1351 mouse in either control port: its buttons read as the fire button
  // (left) and up (right), its position through the SID's paddle lines.
  mouseTypes: [
    { id: C64_MOUSE_PORT1, label: '1351 in port 1' },
    { id: C64_MOUSE_PORT2, label: '1351 in port 2' },
  ],
  cartridge: true,
  systemRomLabel: 'BASIC + KERNAL + characters',
  romPages: 0,
  beeper: false,
  soundChip: 'SID',
  // The Sound pane's SID menu: the original 6581 or the C64C's 8580.
  psgControls: ['sid-model'],
  statusLeds: ['kbd', 'load', 'dsk', 'chip', 'text'],
  keyboardBus: 'matrix',
  tape: 'deck',
  tapeSound: false,
  tapeExtensions: ['.tap', '.t64', '.prg', '.zip'],
  // 'tape-tap' downloads what the KERNAL has SAVEd to tape (as a C64 .tap).
  saveMenu: ['snapshot-c64state', 'tape-tap', 'screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: true,
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

/** The TV standard rides on the locale, as the Atari's does: `'us'` is the
 *  NTSC machine (60 Hz, 263 lines), every other locale the PAL one. */
export function c64IsNtsc(locale: MachineLocale | undefined): boolean {
  return locale === 'us';
}

export function c64Descriptor(model: MachineModel, locale: MachineLocale = 'uk'): MachineDescriptor {
  const timing = c64Timing(c64IsNtsc(locale));
  return {
    kind: 'c64',
    model,
    locale,
    cpuFamily: 'm6502',
    screen: {
      width: C64_SCREEN_WIDTH,
      height: timing.screenHeight,
      pixelAspectX: 1,
      activeWidth: C64_ACTIVE_WIDTH,
      activeHeight: C64_ACTIVE_HEIGHT,
      borderLeft: C64_BORDER_LEFT,
      borderTop: timing.borderTop,
    },
    ui: C64_UI,
  };
}

export const c64Entry: MachineEntry = {
  kind: 'c64',
  models: ['c64'],
  descriptor: c64Descriptor,
  create(model: MachineModel, display: IScreenRenderer | null, locale?: MachineLocale) {
    return new C64Machine(model as C64Model, display, c64IsNtsc(locale));
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
