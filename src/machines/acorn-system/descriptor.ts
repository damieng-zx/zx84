/**
 * Acorn System descriptor — pure metadata plus the machine factory.
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
  builtinDrives: 2,
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
  // Loading only: the CUTS output side is not recorded, so no 'tape-tap'.
  saveMenu: ['screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: false,
  library: false,
  memoryRegions: [],
  charset: 'bbc',
  memoryMappedIo: true,
};

/** A System 3 fits the 8271 card, so the Drive pane and its DISK LED apply. */
const SYSTEM3_UI: MachineUiCapabilities = {
  ...SYSTEM_UI,
  builtinDisk: true,
  statusLeds: ['kbd', 'text', 'dsk'],
};

export function acornSystemDescriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  const info = acornSystemModelInfo(model);
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
    ui: { ...(info.disk ? SYSTEM3_UI : SYSTEM_UI), systemRomLabel: info.romLabel },
  };
}

export const acornSystemEntry: MachineEntry = {
  kind: 'acorn-system',
  models: ['acorn-system2', 'acorn-system3'],
  descriptor: acornSystemDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new AcornSystemMachine(model as AcornSystemModel, display);
  },
  // The COS (2K) or the DOS/kernel (4K) is the system ROM; the resident BASIC
  // is fetched separately by the machine's prepare() hook, since it lives on
  // the memory card.
  romSources(model: MachineModel) {
    return [acornSystemModelInfo(model).romSource];
  },
  /**
   * A raw drop is recognised by shape: 2K is the COS/kernel at &F800, 4K is
   * the System DOS/kernel at &F000. The shape decides the model too, so a DOS
   * lands on a System 3 (with the controller it expects) and a COS on a
   * System 2.
   */
  detectModelForRom(data: Uint8Array): MachineModel | null {
    if (data.length === 0x800) return 'acorn-system2';
    if (data.length === 0x1000) return 'acorn-system3';
    return null;
  },
};
