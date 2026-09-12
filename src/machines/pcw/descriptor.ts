/**
 * Amstrad PCW descriptor — pure metadata plus the machine factory.
 *
 * Imported only by `registry.ts`, and must stay headless-safe: no solid-js, no
 * reactive state, since the MCP server, Node tests and the headless harness all
 * import it.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities,
} from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { PcwModel } from './models.ts';
import { PcwMachine } from './pcw-machine.ts';
import {
  PCW_BORDER_LEFT, PCW_BORDER_TOP, PCW_DISPLAY_HEIGHT, PCW_DISPLAY_WIDTH,
  PCW_SCREEN_HEIGHT, PCW_SCREEN_WIDTH,
} from './constants.ts';

const PCW_UI: MachineUiCapabilities = {
  // No cassette port, no joystick, no mouse fitted, no Sinclair sysvars, and
  // the font pane's ROM-capture heuristic has no ROM to work on here.
  hiddenPanes: [
    'tape-panel', 'microdrive-panel', 'mouse-panel', 'joystick-panel',
    'sysvar-panel', 'font-panel',
  ],
  memoryLayout: true,
  trace: false,
  colorMap: 'mono',
  accuracy: false,
  builtinDisk: true,
  joystick: false,
  fixedJoystick: false,
  mouseTypes: [],
  cartridge: false,
  // There is no ROM in a PCW at all — it boots from the disc in drive A — so
  // the ROM pane's system slot is hidden rather than shown empty.
  systemRomLabel: '',
  systemRomSlot: false,
  romPages: 0,
  beeper: true,
  psgControls: [],
  statusLeds: ['kbd', 'dsk', 'beep', 'text'],
  keyboardBus: 'matrix',
  // No tape hardware: `tape` is omitted entirely rather than set to a mode.
  tapeSound: false,
  tapeExtensions: [],
  saveMenu: ['screenshot-png', 'screen-scr', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: true,
  // No hidden boot disc is offered: a PCW needs a CP/M+ system disc, and
  // whether one can be redistributed is unsettled. Users supply their own.
  bootDisk: false,
  library: false,
  memoryRegions: [],
  charset: 'spectrum',
};

export function pcwDescriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  return {
    kind: 'pcw',
    model,
    locale,
    cpuFamily: 'z80',
    screen: {
      width: PCW_SCREEN_WIDTH,
      height: PCW_SCREEN_HEIGHT,
      // 720x256 of square-ish pixels presents as a 4:3 picture, so the buffer
      // shows at half width: 384x288. Same reasoning as the CPC and the SAM.
      pixelAspectX: 0.5,
      activeWidth: PCW_DISPLAY_WIDTH,
      activeHeight: PCW_DISPLAY_HEIGHT,
      borderLeft: PCW_BORDER_LEFT,
      borderTop: PCW_BORDER_TOP,
    },
    ui: PCW_UI,
  };
}

export const pcwEntry: MachineEntry = {
  kind: 'pcw',
  models: ['pcw8256', 'pcw8512', 'pcw9512'],
  descriptor: pcwDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new PcwMachine(model as PcwModel, display);
  },
  /** No system ROM exists to fetch. The boot code lives on the disc. */
  romSources() {
    return [];
  },
};
