import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { LynxModel } from './models.ts';
import { isLynxModel, lynxHasDisk } from './models.ts';
import { LynxMachine } from './lynx-machine.ts';
import {
  LYNX_ACTIVE_HEIGHT, LYNX_BORDER_TOP, LYNX_GEOMETRY_128, LYNX_GEOMETRY_48,
} from './constants.ts';

/** The panes the Lynx has no hardware for. */
const HIDDEN = ['microdrive-panel', 'mouse-panel', 'sysvar-panel'];

function lynxUi(model: LynxModel): MachineUiCapabilities {
  /** The 96K and 128K carry the disk interface — for now that only shows in
   *  which ROMs they load and which media they will accept. */
  const disk = lynxHasDisk(model);
  return {
    hiddenPanes: HIDDEN,
    memoryLayout: true,
    trace: false,
    // Eight fixed colours from three one-bit planes: nearest the ZX palette's
    // bright half, which is what 'spectrum' names.
    colorMap: 'spectrum',
    // The display is composed a whole scanline at a time under the 6845, with
    // no per-t-state effects to model.
    accuracy: false,
    // The 96K and 128K carry the FD1793 and its DOS ROM, so they show the
    // Drive pane; the 48K has neither.
    builtinDisk: disk,
    joystick: false,
    fixedJoystick: false,
    mouseTypes: [],
    cartridge: false,
    systemRomLabel: disk ? 'System + DOS ROMs' : 'System ROM',
    romPages: 0,
    // A DAC rather than a 1-bit beeper, but it drives the same mixer channel
    // and the same activity LED.
    beeper: true,
    psgControls: [],
    statusLeds: disk ? ['kbd', 'load', 'dsk'] : ['kbd', 'load'],
    keyboardBus: 'matrix',
    tape: 'deck',
    tapeSound: false,
    tapeExtensions: ['.tap', '.zip'],
    // No snapshot or screen-dump service, but a raw RAM dump is universal.
    saveMenu: ['screenshot-png', 'ram-bin'],
    zipPolicy: 'media',
    persistMedia: disk,
    bootDisk: false,
    library: false,
    memoryRegions: [
      { value: 'rom-system', label: 'System ROM' },
      ...(disk ? [{ value: 'rom-dos', label: 'DOS ROM' }] : []),
    ],
    charset: 'spectrum',
  };
}

export function lynxDescriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  const g = model === 'lynx128' ? LYNX_GEOMETRY_128 : LYNX_GEOMETRY_48;
  return {
    kind: 'lynx',
    model,
    locale,
    cpuFamily: 'z80',
    screen: {
      width: g.width,
      height: g.height,
      pixelAspectX: g.pixelAspectX,
      activeWidth: g.activeWidth,
      activeHeight: LYNX_ACTIVE_HEIGHT,
      borderLeft: g.borderLeft,
      borderTop: LYNX_BORDER_TOP,
    },
    ui: lynxUi(isLynxModel(model) ? model : 'lynx48'),
  };
}

export const lynxEntry: MachineEntry = {
  kind: 'lynx',
  models: ['lynx48', 'lynx96', 'lynx128'],
  descriptor: lynxDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new LynxMachine(model as LynxModel, display);
  },
  /**
   * The 8K system images in load order, then — on the machines with a disk
   * interface — the DOS ROM, which the machine splices in at the top of bank 0
   * rather than after the others.
   */
  romSources(model: MachineModel) {
    if (model === 'lynx128') {
      return [
        'camputers/lynx128-1.rom', 'camputers/lynx128-2.rom', 'camputers/lynx128-3.rom',
        'camputers/dosrom.rom',
      ];
    }
    if (model === 'lynx96') {
      return [
        'camputers/lynx96-1.rom', 'camputers/lynx96-2.rom', 'camputers/lynx96-3.rom',
        'camputers/dosrom.rom',
      ];
    }
    return ['camputers/lynx48-1.rom', 'camputers/lynx48-2.rom'];
  },
  /** 16K is the 48K's ROM; 32K is a 96K or 128K set with its DOS ROM, and
   *  which of those it is cannot be told from the size, so the current model
   *  decides. */
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    if (data.length === 0x4000) return 'lynx48';
    if (data.length !== 0x6000 && data.length !== 0x8000) return null;
    return current === 'lynx128' ? 'lynx128' : 'lynx96';
  },
};
