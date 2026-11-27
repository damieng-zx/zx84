/**
 * Commodore Plus/4 and Commodore 16 descriptor — pure metadata plus the machine
 * factory.
 *
 * Imported only by `registry.ts`; stays headless-safe (no solid-js, no
 * reactive state).
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { plus4IsNtsc, plus4RomSize, plus4RomSources, type Plus4Model } from './models.ts';
import { Plus4Machine } from './plus4-machine.ts';
import { PLUS4_JOY_PORT1, PLUS4_JOY_PORT2 } from './services/input.ts';
import { plus4PixelAspect, plus4Screen, plus4Timing } from './constants.ts';

const PLUS4_UI: MachineUiCapabilities = {
  hiddenPanes: ['microdrive-panel', 'sysvar-panel', 'font-panel'],
  memoryLayout: true,
  trace: true,
  traceModes: ['full', 'portio'],
  // The TED's 128 colours are fixed (palette.ts).
  accuracy: false,
  // The drive is on the serial bus; the Hardware pane plugs it in or out.
  builtinDisk: true,
  requires: { builtinDisk: 'plus4-drive' },
  builtinDrives: 4,
  builtinDriveLabels: ['Drive 8', 'Drive 9', 'Drive 10', 'Drive 11'],
  driveModels: [
    { value: '1541', label: '1541', title: '5.25" GCR disks: .d64, .g64' },
    { value: '1571', label: '1571', title: '5.25" double-sided GCR disks: .d71, and the 1541\'s .d64, .g64' },
    { value: '1581', label: '1581', title: '3.5" 800K disks: .d81' },
  ],
  defaultDriveModels: ['1541'],
  // Two control ports, read through the TED's keyboard register.
  joystick: true,
  fixedJoystick: false,
  joystickTypes: [
    { id: PLUS4_JOY_PORT1, label: 'Control port 1' },
    { id: PLUS4_JOY_PORT2, label: 'Control port 2' },
  ],
  joystickFireButtons: 1,
  mouseTypes: [],
  // ROM in the two banked halves at $8000 and $C000; fitting one is a power
  // cycle, and `$FDD0` selects it.
  cartridge: true,
  bootCartridge: true,
  systemRomLabel: 'KERNAL + BASIC + 3+1',
  romPages: 0,
  beeper: false,
  soundChip: 'TED',
  psgControls: [],
  statusLeds: ['kbd', 'load', 'dsk', 'chip', 'text'],
  keyboardBus: 'matrix',
  tape: 'deck',
  tapeSound: true,
  tapeExtensions: ['.tap', '.t64', '.prg', '.zip'],
  saveMenu: ['tape-tap', 'screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: false,
  library: false,
  memoryRegions: [
    { value: 'rom-bottom', label: 'ROM low bank (BASIC)' },
    { value: 'rom-top', label: 'ROM high bank (KERNAL)' },
    { value: 'rom-func-low', label: '3+1 low ROM' },
    { value: 'rom-func-high', label: '3+1 high ROM' },
    { value: 'colour-ram', label: 'Colour RAM' },
  ],
  charset: 'spectrum',
  memoryMappedIo: true,
};

export function plus4Descriptor(model: MachineModel, locale: MachineLocale = 'uk'): MachineDescriptor {
  const ntsc = plus4IsNtsc(locale);
  const t = plus4Timing(ntsc);
  const s = plus4Screen(t);
  return {
    kind: 'plus4',
    model,
    locale,
    cpuFamily: 'm6502',
    screen: {
      width: s.width,
      height: s.height,
      pixelAspectX: plus4PixelAspect(ntsc),
      activeWidth: s.activeWidth,
      activeHeight: s.activeHeight,
      borderLeft: s.borderLeft,
      borderTop: s.borderTop,
    },
    ui: PLUS4_UI,
  };
}

export const plus4Entry = {
  kind: 'plus4',
  models: ['plus4', 'c16'] as const,
  descriptor: plus4Descriptor,
  create(model: MachineModel, display: IScreenRenderer | null, locale?: MachineLocale) {
    return new Plus4Machine(model as Plus4Model, display, plus4IsNtsc(locale));
  },
  romSources(model: MachineModel, locale?: MachineLocale) {
    return [...plus4RomSources(model as Plus4Model, plus4IsNtsc(locale))];
  },
  /** The whole system image is KERNAL + BASIC (+ the 3+1 ROMs); a 32K image is
   *  the C16's, a 64K one the Plus/4's. */
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    if (data.length === plus4RomSize('c16') && (current === 'c16' || current === 'plus4')) return 'c16';
    if (data.length === plus4RomSize('plus4')) return 'plus4';
    return null;
  },
} satisfies MachineEntry;
