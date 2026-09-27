/**
 * BBC Micro Model B descriptor — pure metadata plus the machine factory.
 *
 * Imported only by `registry.ts`; stays headless-safe (no solid-js, no reactive
 * state) because the MCP server, Node tests and the headless harness import it.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { BbcModel } from './models.ts';
import { BbcMachine } from './bbc-machine.ts';
import {
  BBC_ACTIVE_HEIGHT, BBC_ACTIVE_WIDTH, BBC_BORDER_LEFT, BBC_BORDER_TOP,
  BBC_SCREEN_HEIGHT, BBC_SCREEN_WIDTH,
} from './constants.ts';

const BBC_UI: MachineUiCapabilities = {
  hiddenPanes: [
    'tape-panel', 'microdrive-panel', 'mouse-panel', 'joystick-panel',
    'sysvar-panel', 'font-panel', 'banks-panel',
  ],
  memoryLayout: false,
  trace: false,
  // Mode 7 / ULA palette control; 'bbc' selects the BBC palette family.
  colorMap: 'bbc',
  accuracy: false,
  builtinDisk: true,
  builtinDrives: 2,
  joystick: false,
  fixedJoystick: false,
  mouseTypes: [],
  cartridge: false,
  systemRomLabel: 'OS + BASIC ROMs',
  romPages: 0,
  beeper: false,
  psgControls: ['sn-stereo', 'filter'],
  statusLeds: ['kbd', 'dsk', 'psg', 'text'],
  keyboardBus: 'matrix',
  tapeSound: false,
  tapeExtensions: [],
  saveMenu: ['screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: true,
  bootDisk: false,
  library: false,
  memoryRegions: [],
  charset: 'bbc',
};

export function bbcDescriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  return {
    kind: 'bbc',
    model,
    locale,
    cpuFamily: 'm6502',
    screen: {
      width: BBC_SCREEN_WIDTH,
      height: BBC_SCREEN_HEIGHT,
      // One buffer line per scanline and 640 pixels across, so a buffer pixel
      // is half as wide as it is tall: show it at half width (1x = 384×288),
      // like the CPC, which shares the 6845 and PAL timing.
      pixelAspectX: 0.5,
      activeWidth: BBC_ACTIVE_WIDTH,
      activeHeight: BBC_ACTIVE_HEIGHT,
      borderLeft: BBC_BORDER_LEFT,
      borderTop: BBC_BORDER_TOP,
    },
    ui: BBC_UI,
  };
}

export const bbcEntry: MachineEntry = {
  kind: 'bbc',
  models: ['bbc-b'],
  descriptor: bbcDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new BbcMachine(model as BbcModel, display);
  },
  // Concatenated in the order BbcMemory.loadRom expects: 16K OS then 16K BASIC.
  romSources() {
    return ['bbc/os12.rom', 'bbc/basic2.rom'];
  },
};
