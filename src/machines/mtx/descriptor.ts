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
  hiddenPanes: ['microdrive-panel', 'mouse-panel', 'sysvar-panel'],
  memoryLayout: true,
  trace: true,
  colorMap: 'msx',
  // VDP-based scanline rendering — no per-t-state Accuracy dropdown (as MSX).
  accuracy: false,
  builtinDisk: true,
  joystick: true,
  fixedJoystick: true,
  mouseTypes: [],
  cartridge: true,
  systemRomLabel: 'OS + BASIC + ASSEM + CP/M + FDX ROMs',
  romPages: 0,
  beeper: false,
  // An SN76489, not an AY: it takes the anti-alias strategy and nothing else.
  psgControls: ['filter'],
  statusLeds: ['kbd', 'load', 'dsk', 'psg', 'text'],
  keyboardBus: 'matrix',
  tape: 'instant',
  tapeSound: false,
  tapeExtensions: ['.mtx', '.zip'],
  saveMenu: 'vdp',
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: true,
  library: false,
  memoryRegions: [
    { value: 'rom-os', label: 'OS ROM' },
    { value: 'rom-basic', label: 'BASIC ROM' },
    { value: 'rom-assem', label: 'Assembler ROM' },
    { value: 'rom-cpm', label: 'CP/M Bootstrap ROM' },
    { value: 'rom-fdx', label: 'FDX Disk BASIC ROM' },
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
  models: ['mtx500', 'mtx512', 'rs128'],
  descriptor: mtxDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new MtxMachine(model as MtxModel, display);
  },
  // The first three physical 8K ROMs are the MTX motherboard firmware. The
  // Type 07 bootstrap and Disk BASIC ROMs occupy pages 4 and 5.
  romSources() {
    return [
      'memotech/os.rom',
      'memotech/basic.rom',
      'memotech/assem.rom',
      'memotech/boot-type07.rom',
      'memotech/sdx-type07.rom',
    ];
  },
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    if (data.length !== 0x6000 && data.length !== 0x8000 && data.length !== 0xA000) return null;
    return isMtxModel(current) ? current : 'mtx512';
  },
};
