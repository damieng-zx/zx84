/**
 * MSX registry entry — pure metadata + factory.
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type { MachineDescriptor, MachineEntry, MachineLocale, MachineUiCapabilities } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { isMsxModel, type MsxModel } from './models.ts';
import { createMsxConfig } from './config.ts';
import { MsxMachine } from './msx-machine.ts';
import {
  MSX_SCREEN_WIDTH, MSX_SCREEN_HEIGHT, MSX_BORDER_LEFT, MSX_BORDER_TOP,
} from './constants.ts';

const MSX_UI: MachineUiCapabilities = {
  // No system-variables view (only the Spectrum contributes one).
  hiddenPanes: ['sysvar-panel'],
  memoryLayout: true,
  trace: false,
  colorMap: 'msx',
  accuracy: false,
  // The floppy interface is a Hardware-pane option: the Drives pane shows only
  // while it is fitted (see DrivePane's msxFloppy gate).
  builtinDisk: true,
  builtinDrives: 2,
  joystick: true,
  fixedJoystick: true,
  mouseTypes: [],
  cartridge: true,
  systemRomLabel: 'System ROM',
  romPages: 0,
  beeper: true,
  psgControls: ['stereo', 'filter', 'dc-block'],
  // PSG (AY-3-8910) sound, cassette load, keyboard and OCR. The MSX has no
  // Spectrum-style EAR/rainbow/Kempston activity to indicate.
  soundChip: 'AY-3-8910',
  statusLeds: ['kbd', 'load', 'chip', 'text'],
  keyboardBus: 'ula',
  tape: 'instant',
  tapeSound: true,
  tapeExtensions: ['.cas', '.zip'],
  // 'tape-tap' downloads what the BIOS has saved to cassette (as .cas).
  saveMenu: ['tape-tap', 'screenshot-png', 'screen-scr', 'ram-bin'],
  zipPolicy: 'media',
  persistMedia: false,
  bootDisk: false,
  library: false,
  memoryRegions: [
    { value: 'rom0', label: 'ROM 0' },
    { value: 'rom-firmware', label: 'Data Bank ROM' },
    { value: 'rom-disk', label: 'Disk ROM' },
  ],
  charset: 'spectrum',
};

/** Descriptor for an MSX model — shared by the registry entry and the machine
 *  instance's own `descriptor` getter. */
export function msxDescriptor(model: MachineModel, locale: MachineLocale = 'uk'): MachineDescriptor {
  return {
    kind: 'msx',
    model,
    locale,
    cpuFamily: 'z80',
    screen: {
      width: MSX_SCREEN_WIDTH, height: MSX_SCREEN_HEIGHT, pixelAspectX: 1,
      activeWidth: 256, activeHeight: 192,
      borderLeft: MSX_BORDER_LEFT, borderTop: MSX_BORDER_TOP,
    },
    ui: MSX_UI,
  };
}

export const msxEntry: MachineEntry = {
  kind: 'msx',
  models: ['hx-10', 'hb-55', 'hb-55p'],
  descriptor: msxDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new MsxMachine(model as MsxModel, display);
  },
  romSources(model?: MachineModel, _locale?: MachineLocale) {
    return [createMsxConfig(model !== undefined && isMsxModel(model) ? model : 'hx-10').biosSource];
  },
};
