/**
 * Commodore VIC-20 descriptor — pure metadata plus the machine factory.
 *
 * Imported only by `registry.ts`; stays headless-safe (no solid-js, no
 * reactive state).
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { vic20IsNtsc, vic20RomSources, type Vic20Model } from './models.ts';
import { Vic20Machine } from './vic20-machine.ts';
import { VIC20_JOY_PORT, VIC20_MOUSE_PADDLES } from './services/input.ts';
import { VIC20_ROM_SIZE, vic20PixelAspect, vic20Screen, vic20Timing } from './constants.ts';

const VIC20_UI: MachineUiCapabilities = {
  hiddenPanes: ['microdrive-panel', 'sysvar-panel', 'font-panel'],
  memoryLayout: true,
  trace: true,
  traceModes: ['full', 'portio'],
  // The VIC's sixteen colours are fixed (palette.ts).
  colorMap: 'mono',
  accuracy: false,
  // The drives are on the serial bus, as on the C64; the Hardware pane plugs
  // them in or out and the Drives pane's "..." menu adds, removes and picks
  // each one's model (devices 8 to 11).
  builtinDisk: true,
  requires: { builtinDisk: 'vic20-drive' },
  builtinDrives: 4,
  builtinDriveLabels: ['Drive 8', 'Drive 9', 'Drive 10', 'Drive 11'],
  driveModels: [
    { value: '1541', label: '1541', title: '5.25" GCR disks: .d64, .g64' },
    { value: '1571', label: '1571', title: '5.25" double-sided GCR disks: .d71, and the 1541\'s .d64, .g64' },
    { value: '1581', label: '1581', title: '3.5" 800K disks: .d81' },
  ],
  defaultDriveModels: ['1541'],
  // One control port: up, down, left and fire on VIA 1, right on VIA 2.
  joystick: true,
  fixedJoystick: false,
  joystickTypes: [{ id: VIC20_JOY_PORT, label: 'Control port' }],
  joystickFireButtons: 1,
  joystickPlayers: 1,
  // A pair of paddles in the control port, turned with the host mouse.
  mouseTypes: [{ id: VIC20_MOUSE_PADDLES, label: 'Paddles' }],
  cartridge: false,
  systemRomLabel: 'BASIC + KERNAL + characters',
  romPages: 0,
  beeper: false,
  soundChip: 'VIC',
  psgControls: [],
  statusLeds: ['kbd', 'load', 'dsk', 'chip', 'text'],
  keyboardBus: 'matrix',
  tape: 'deck',
  tapeSound: false,
  tapeExtensions: ['.tap', '.t64', '.prg', '.zip'],
  // 'tape-tap' downloads what the KERNAL has SAVEd to tape (as a VIC-20 .tap).
  saveMenu: ['snapshot-vic20state', 'tape-tap', 'screenshot-png', 'ram-bin'],
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

export function vic20Descriptor(model: MachineModel, locale: MachineLocale = 'uk'): MachineDescriptor {
  const ntsc = vic20IsNtsc(locale);
  const s = vic20Screen(vic20Timing(ntsc));
  return {
    kind: 'vic20',
    model,
    locale,
    cpuFamily: 'm6502',
    screen: {
      width: s.width,
      height: s.height,
      pixelAspectX: vic20PixelAspect(ntsc),
      activeWidth: s.activeWidth,
      activeHeight: s.activeHeight,
      borderLeft: s.borderLeft,
      borderTop: s.borderTop,
    },
    ui: VIC20_UI,
  };
}

export const vic20Entry: MachineEntry = {
  kind: 'vic20',
  models: ['vic20'],
  descriptor: vic20Descriptor,
  create(model: MachineModel, display: IScreenRenderer | null, locale?: MachineLocale) {
    return new Vic20Machine(model as Vic20Model, display, vic20IsNtsc(locale));
  },
  romSources(_model: MachineModel, locale?: MachineLocale) {
    return [...vic20RomSources(vic20IsNtsc(locale))];
  },
  /** The three ROMs at an 8K stride (20K) are a VIC-20's system ROM, but so
   *  is a C64's, so only when already a VIC-20. */
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    return data.length === VIC20_ROM_SIZE && current === 'vic20' ? 'vic20' : null;
  },
};
