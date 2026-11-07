/**
 * Acorn Electron descriptor — pure metadata plus the machine factory.
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
import type { ElectronModel } from './models.ts';
import { ElectronMachine } from './electron-machine.ts';
import {
  ELECTRON_ACTIVE_HEIGHT, ELECTRON_ACTIVE_WIDTH, ELECTRON_BORDER_LEFT, ELECTRON_BORDER_TOP,
  ELECTRON_PIXEL_ASPECT_X, ELECTRON_SCREEN_HEIGHT, ELECTRON_SCREEN_WIDTH,
} from './constants.ts';

const ELECTRON_UI: MachineUiCapabilities = {
  // No microdrive or mouse, and nothing to show in the Spectrum-style
  // sysvar/font/banks panes. The Drives pane is kept: it lists the Plus 3's
  // drives once that is fitted and nothing before; the Joysticks pane, the
  // Plus 1's analogue port the same way.
  hiddenPanes: [
    'microdrive-panel', 'mouse-panel',
    'sysvar-panel', 'font-panel', 'banks-panel',
  ],
  memoryLayout: false,
  trace: true,
  traceModes: ['full', 'portio'],
  // The ULA's eight colours are the BBC's: share its PAL / Measured choice.
  colorMap: 'bbc',
  accuracy: 'raster',
  // The Plus 3's disc drives and the Plus 1's cartridge slot are Hardware-pane
  // peripherals: the capabilities are declared here and the panes show them only
  // while the matching setting is on.
  builtinDisk: true,
  builtinDrives: 2,
  requires: { builtinDisk: 'electron-plus3', cartridge: 'electron-plus1', joystick: 'electron-plus1' },
  // The Plus 1's analogue port: two proportional sticks on its ADC0844, one
  // fire button each.
  joystick: true,
  fixedJoystick: true,
  joystickFireButtons: 1,
  mouseTypes: [],
  cartridge: true,
  systemRomLabel: 'OS + BASIC ROM',
  romPages: 0,
  // The ULA's 1-bit speaker; nothing to balance it against.
  beeper: true,
  psgControls: [],
  statusLeds: ['kbd', 'load', 'dsk', 'beep', 'text'],
  keyboardBus: 'matrix',
  tape: 'deck',
  tapeSound: false,
  tapeExtensions: ACORN_TAPE_EXTENSIONS,
  // 'tape-tap' downloads whatever the OS has SAVEd to the cassette port (.uef);
  // 'printer-txt' what was sent to the Plus 1's printer port.
  saveMenu: ['snapshot-elkstate', 'tape-tap', 'printer-txt', 'screenshot-png', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: true,
  bootDisk: false,
  library: false,
  memoryRegions: [],
  charset: 'bbc',
  memoryMappedIo: true,
};

export function electronDescriptor(
  model: MachineModel,
  locale: MachineLocale = 'uk',
): MachineDescriptor {
  return {
    kind: 'electron',
    model,
    locale,
    cpuFamily: 'm6502',
    screen: {
      width: ELECTRON_SCREEN_WIDTH,
      height: ELECTRON_SCREEN_HEIGHT,
      // The 640-pixel modes put two buffer pixels in the width of one TV
      // scanline's worth of height: show them at half width (1x = 384×288).
      pixelAspectX: ELECTRON_PIXEL_ASPECT_X,
      activeWidth: ELECTRON_ACTIVE_WIDTH,
      activeHeight: ELECTRON_ACTIVE_HEIGHT,
      borderLeft: ELECTRON_BORDER_LEFT,
      borderTop: ELECTRON_BORDER_TOP,
    },
    ui: ELECTRON_UI,
  };
}

export const electronEntry: MachineEntry = {
  kind: 'electron',
  models: ['electron'],
  descriptor: electronDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new ElectronMachine(model as ElectronModel, display);
  },
  // Concatenated in the order ElectronMemory.loadRom expects: 16K BASIC, then
  // the 16K OS — the layout of the Electron's single 32K mask ROM.
  romSources() {
    return ['electron/basic.rom', 'electron/os.rom'];
  },
};
