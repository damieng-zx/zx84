import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { MtxModel } from './models.ts';
import { isMtxModel } from './models.ts';
import { MtxMachine } from './mtx-machine.ts';
import {
  MTX_BORDER_LEFT, MTX_BORDER_TOP, MTX_SCREEN_HEIGHT, MTX_SCREEN_WIDTH,
} from './constants.ts';

const MTX_UI: MachineUiCapabilities = {
  hiddenPanes: ['drive-panel', 'microdrive-panel', 'mouse-panel', 'sysvar-panel'],
  memoryLayout: true,
  trace: true,
  colorMap: 'msx',
  builtinDisk: false,
  joystick: false,
  fixedJoystick: false,
  mouse: false,
  cartridge: false,
  systemRomLabel: 'OS + BASIC + ASSEM ROMs',
  romPages: 0,
  beeper: false,
  statusLeds: ['kbd', 'psg'],
  keyboardBus: 'matrix',
  tapeSound: false,
  tapeExtensions: [],
  saveMenu: 'vdp',
  zipPolicy: 'none',
  persistMedia: false,
  bootDisk: false,
  library: false,
  memoryRegions: [
    { value: 'rom-os', label: 'OS ROM' },
    { value: 'rom-basic', label: 'BASIC ROM' },
    { value: 'rom-assem', label: 'Assembler ROM' },
  ],
  charset: 'spectrum',
};

export function mtxDescriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  return {
    kind: 'mtx',
    model,
    locale,
    cpuFamily: 'z80',
    screen: {
      width: MTX_SCREEN_WIDTH,
      height: MTX_SCREEN_HEIGHT,
      pixelAspectX: 1,
      activeWidth: 256,
      activeHeight: 192,
      borderLeft: MTX_BORDER_LEFT,
      borderTop: MTX_BORDER_TOP,
    },
    ui: MTX_UI,
  };
}

export const mtxEntry: MachineEntry = {
  kind: 'mtx',
  models: ['mtx500', 'mtx512'],
  descriptor: mtxDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new MtxMachine(model as MtxModel, display);
  },
  // These are the three physical 8K ROM images, concatenated by ROMManager.
  // The project ROM CDN needs matching files; users can already install a
  // combined 24K dump through the generic system-ROM service.
  romSources() {
    return ['mtx/os.rom', 'mtx/basic.rom', 'mtx/assem.rom'];
  },
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    if (data.length !== 0x6000) return null;
    return isMtxModel(current) ? current : 'mtx512';
  },
};
