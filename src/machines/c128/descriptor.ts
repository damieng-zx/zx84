/**
 * Commodore 128 descriptor — pure metadata plus the machine factory.
 *
 * Imported only by `registry.ts`; stays headless-safe (no solid-js, no
 * reactive state).
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { C128_ROM_SOURCES, C128_ROM_TOTAL } from './models.ts';
import { C128Machine } from './c128-machine.ts';
import { C128_JOY_PORT1, C128_JOY_PORT2, C128_MOUSE_PORT1, C128_MOUSE_PORT2 } from './services/input.ts';
import {
  C128_ACTIVE_HEIGHT, C128_ACTIVE_WIDTH, C128_BORDER_LEFT, C128_SCREEN_WIDTH, c128Timing,
} from './constants.ts';
import { VDC_FRAME_HEIGHT, VDC_FRAME_WIDTH, VDC_PIXEL_ASPECT_X } from './vdc-display.ts';

const C128_UI: MachineUiCapabilities = {
  hiddenPanes: ['microdrive-panel', 'sysvar-panel', 'font-panel'],
  memoryLayout: true,
  trace: true,
  traceModes: ['full', 'portio'],
  // The VIC-IIe's sixteen colours and the VDC's RGBI ones are fixed.
  colorMap: 'mono',
  accuracy: false,
  // The drive is on the serial bus; the Hardware pane plugs it in or out.
  builtinDisk: true,
  requires: { builtinDisk: 'c128-drive' },
  builtinDrives: 4,
  builtinDriveLabels: ['Drive 8', 'Drive 9', 'Drive 10', 'Drive 11'],
  // Up to four drives, devices 8 to 11, each a 1541, a 1571 or a 1581. The 128's
  // own is the 1571, whose burst-mode fast serial the 128's KERNAL uses.
  driveModels: [
    { value: '1541', label: '1541', title: '5.25" GCR disks: .d64, .g64 (no burst mode: the KERNAL falls back to the slow bus)' },
    { value: '1571', label: '1571', title: '5.25" double-sided GCR disks: .d71, and the 1541\'s .d64, .g64; burst mode' },
    { value: '1581', label: '1581', title: '3.5" 800K disks: .d81; burst mode' },
  ],
  defaultDriveModels: ['1571'],
  // Two control ports on CIA 1, as on the 64.
  joystick: true,
  fixedJoystick: false,
  joystickTypes: [
    { id: C128_JOY_PORT1, label: 'Control port 1' },
    { id: C128_JOY_PORT2, label: 'Control port 2' },
  ],
  joystickFireButtons: 1,
  // A 1351 mouse in either control port, as on the 64.
  mouseTypes: [
    { id: C128_MOUSE_PORT1, label: '1351 in port 1' },
    { id: C128_MOUSE_PORT2, label: '1351 in port 2' },
  ],
  // The expansion port: 64 cartridges in 64 mode, function ROMs in 128 mode.
  cartridge: true,
  systemRomLabel: 'BASIC 7 + system + characters + 64 ROMs',
  romPages: 0,
  beeper: false,
  soundChip: 'SID',
  // The Sound pane's SID menu: the original 6581 or the later 8580.
  psgControls: ['sid-model'],
  statusLeds: ['kbd', 'load', 'dsk', 'chip', 'columns', 'text'],
  keyboardBus: 'matrix',
  // The 128 shares the Commodore legend (its `"` is SHIFT+2, arithmetic caps
  // are their own keys): the character decides, not the PC's position.
  typedCharacters: true,
  tape: 'deck',
  tapeSound: true,
  tapeExtensions: ['.tap', '.t64', '.prg', '.zip'],
  // 'tape-tap' downloads what the KERNAL has SAVEd to tape (as a C64 .tap).
  saveMenu: ['snapshot-c128state', 'tape-tap', 'screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: true,
  bootDisk: false,
  // A cartridge mounted from a file is kept across a reload (the slot has no
  // hidden default cartridge: there is no `bootCartridgeSource`).
  bootCartridge: true,
  library: false,
  memoryRegions: [
    { value: 'rom-basic-lo', label: 'BASIC low ROM' },
    { value: 'rom-basic-hi', label: 'BASIC high ROM' },
    { value: 'rom-system', label: 'System ROM' },
    { value: 'rom-chargen', label: 'Character ROM' },
    { value: 'rom-basic64', label: '64 BASIC ROM' },
    { value: 'rom-kernal64', label: '64 KERNAL ROM' },
    { value: 'color-ram', label: 'Colour RAM' },
    { value: 'vdc-ram', label: 'VDC RAM' },
  ],
  charset: 'spectrum',
  memoryMappedIo: true,
};

/** The TV standard rides on the locale, as the 64's does: `'us'` is the NTSC
 *  machine (60 Hz, 263 lines), every other locale the PAL one. */
export function c128IsNtsc(locale: MachineLocale | undefined): boolean {
  return locale === 'us';
}

/**
 * The machine's metadata. The one canvas shows either video chip, so the
 * screen is the VIC-IIe's frame or, with `is80`, the 80-column VDC's (a live
 * machine reports which through `descriptor`).
 */
export function c128Descriptor(
  model: MachineModel, locale: MachineLocale = 'uk', is80 = false,
): MachineDescriptor {
  const timing = c128Timing(c128IsNtsc(locale));
  return {
    kind: 'c128',
    model,
    locale,
    cpuFamily: 'm6502',
    screen: is80
      ? {
        width: VDC_FRAME_WIDTH,
        height: VDC_FRAME_HEIGHT,
        pixelAspectX: VDC_PIXEL_ASPECT_X,
        activeWidth: 640,
        activeHeight: 200,
        borderLeft: (VDC_FRAME_WIDTH - 640) >> 1,
        borderTop: (VDC_FRAME_HEIGHT - 200) >> 1,
      }
      : {
        width: C128_SCREEN_WIDTH,
        height: timing.screenHeight,
        pixelAspectX: 1,
        activeWidth: C128_ACTIVE_WIDTH,
        activeHeight: C128_ACTIVE_HEIGHT,
        borderLeft: C128_BORDER_LEFT,
        borderTop: timing.borderTop,
      },
    ui: C128_UI,
  };
}

export const c128Entry: MachineEntry = {
  kind: 'c128',
  models: ['c128'],
  descriptor: c128Descriptor,
  create(_model: MachineModel, display: IScreenRenderer | null, locale?: MachineLocale) {
    return new C128Machine(display, c128IsNtsc(locale));
  },
  romSources() {
    return [...C128_ROM_SOURCES];
  },
  /** The six ROMs end to end (72K) are a 128's system ROM. */
  detectModelForRom(data: Uint8Array): MachineModel | null {
    return data.length === C128_ROM_TOTAL ? 'c128' : null;
  },
};
