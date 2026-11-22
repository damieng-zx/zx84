/**
 * Acorn System 2 descriptor — pure metadata plus the machine factory.
 *
 * Imported only by `registry.ts`; stays headless-safe (no solid-js, no reactive
 * state) because the MCP server, Node tests and the headless harness import it.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { ACORN_TAPE_EXTENSIONS } from '@/machines/shared/acorn-tape-service.ts';
import { acornSystemModelInfo, type AcornSystemModel } from './models.ts';
import { AcornSystemMachine } from './machine.ts';
import {
  ACORN_SYSTEM_ACTIVE_HEIGHT, ACORN_SYSTEM_ACTIVE_WIDTH, ACORN_SYSTEM_BORDER_LEFT,
  ACORN_SYSTEM_BORDER_TOP, ACORN_SYSTEM_PIXEL_ASPECT_X, ACORN_SYSTEM_SCREEN_HEIGHT,
  ACORN_SYSTEM_SCREEN_WIDTH,
} from './constants.ts';

const SYSTEM_UI: MachineUiCapabilities = {
  hiddenPanes: [
    'microdrive-panel', 'mouse-panel', 'sysvar-panel', 'font-panel', 'banks-panel',
  ],
  memoryLayout: false,
  trace: true,
  traceModes: ['full', 'portio'],
  // The teletext card's eight SAA5050 colours: the BBC's palette family, and
  // the machine honours 'bbc-color-map' (PAL or measured levels).
  colorMap: 'bbc',
  accuracy: false,
  builtinDisk: false,
  joystick: false,
  fixedJoystick: false,
  mouseTypes: [],
  cartridge: false,
  systemRomLabel: 'COS ROM',
  romPages: 0,
  beeper: false,
  psgControls: [],
  statusLeds: ['kbd', 'text'],
  keyboardBus: 'matrix',
  tape: 'deck',
  tapeSound: false,
  tapeExtensions: ACORN_TAPE_EXTENSIONS,
  // Loading only: the CUTS output side is not recorded yet, so no 'tape-tap'.
  saveMenu: ['screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: false,
  library: false,
  memoryRegions: [],
  charset: 'bbc',
  memoryMappedIo: true,
};

export function acornSystemDescriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  return {
    kind: 'acorn-system',
    model,
    locale,
    cpuFamily: 'm6502',
    screen: {
      width: ACORN_SYSTEM_SCREEN_WIDTH,
      height: ACORN_SYSTEM_SCREEN_HEIGHT,
      pixelAspectX: ACORN_SYSTEM_PIXEL_ASPECT_X,
      activeWidth: ACORN_SYSTEM_ACTIVE_WIDTH,
      activeHeight: ACORN_SYSTEM_ACTIVE_HEIGHT,
      borderLeft: ACORN_SYSTEM_BORDER_LEFT,
      borderTop: ACORN_SYSTEM_BORDER_TOP,
    },
    ui: { ...SYSTEM_UI, systemRomLabel: acornSystemModelInfo(model).romLabel },
  };
}

export const acornSystemEntry: MachineEntry = {
  kind: 'acorn-system',
  models: ['acorn-system2'],
  descriptor: acornSystemDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new AcornSystemMachine(model as AcornSystemModel, display);
  },
  // The COS/kernel is the system ROM; the resident BASIC is fetched separately
  // by the machine's prepare() hook, since it lives on the memory card.
  romSources(model: MachineModel) {
    return [acornSystemModelInfo(model).romSource];
  },
  /**
   * A raw drop is recognised by shape: 2K is the COS/kernel at &F800, 4K is a
   * System DOS/kernel at &F000 (which this memory map also decodes, so a
   * System 3 ROM boots to its prompt with no disc controller fitted).
   */
  detectModelForRom(data: Uint8Array): MachineModel | null {
    return data.length === 0x800 || data.length === 0x1000 ? 'acorn-system2' : null;
  },
};
