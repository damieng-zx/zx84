/**
 * Grundy NewBrain registry entry — pure metadata + factory.
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type { MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { NewBrainModel } from './models.ts';
import { NewBrainMachine } from './newbrain-machine.ts';
import { NB_IMAGE_SIZE, NB_ROM_SIZE, NB_SCREEN_HEIGHT, NB_SCREEN_WIDTH } from './constants.ts';

const NEWBRAIN_UI: MachineUiCapabilities = {
  // No drives, joystick, mouse, PSG or microdrive; the picture comes out of
  // RAM, so there is no font or system-variable view to offer.
  hiddenPanes: [
    'drive-panel', 'microdrive-panel', 'joystick-panel', 'mouse-panel',
    'font-panel', 'sysvar-panel', 'banks-panel',
  ],
  memoryLayout: false,
  trace: true,
  colorMap: 'mono',
  accuracy: false,
  builtinDisk: false,
  joystick: false,
  fixedJoystick: false,
  mouseTypes: [],
  cartridge: false,
  systemRomLabel: 'ROM',
  romPages: 0,
  // The NewBrain has no loudspeaker the model knows of.
  beeper: false,
  psgControls: [],
  statusLeds: ['kbd', 'ear', 'load', 'text'],
  keyboardBus: 'matrix',
  tape: 'deck',
  tapeSound: false,
  tapeExtensions: ['.wav', '.csw', '.zip'],
  saveMenu: ['tape-tap', 'screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: true,
  bootDisk: false,
  library: false,
  memoryRegions: [
    { value: 'rom0', label: 'ROM' },
    { value: 'ram', label: 'RAM' },
    { value: 'cop', label: 'COP420 firmware' },
    { value: 'chars', label: 'Character ROM' },
  ],
  charset: 'spectrum',
};

/** Descriptor for the NewBrain — shared by the registry entry and the machine
 *  instance's own `descriptor` getter. */
export function newBrainDescriptor(model: MachineModel, locale: MachineLocale = 'uk'): MachineDescriptor {
  return {
    kind: 'newbrain',
    model,
    locale,
    cpuFamily: 'z80',
    screen: {
      width: NB_SCREEN_WIDTH, height: NB_SCREEN_HEIGHT,
      // 640 dots across a 4:3 tube: each dot is about half as wide as it is tall.
      pixelAspectX: 0.5,
      activeWidth: NB_SCREEN_WIDTH, activeHeight: NB_SCREEN_HEIGHT,
      borderLeft: 0, borderTop: 0,
    },
    ui: NEWBRAIN_UI,
  };
}

export const newBrainEntry: MachineEntry = {
  kind: 'newbrain',
  models: ['newbrain'],
  descriptor: newBrainDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new NewBrainMachine(model as NewBrainModel, display);
  },
  /**
   * The three 8K Z80 ROMs in address order (A000, C000, E000), then the
   * COP420's 1K firmware and the 4K character generator. The shell joins them
   * into the one image `NewBrainMemory.loadROM` takes apart again.
   */
  romSources(_model?: MachineModel, _locale?: MachineLocale) {
    return [
      'grundy/newbrain-a.rom', 'grundy/newbrain-cd.rom', 'grundy/newbrain-ef.rom',
      'grundy/newbrain-cop.rom', 'grundy/newbrain-char.rom',
    ];
  },
  /** The complete 29K image is an odd enough size to claim for the NewBrain
   *  from any machine. (A bare 24K set is the size of the Lynx 96K's ROMs, so
   *  it only counts once the NewBrain is already active.) */
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    if (data.length === NB_IMAGE_SIZE) return 'newbrain';
    if (current === 'newbrain' && data.length === NB_ROM_SIZE) return current;
    return null;
  },
};
