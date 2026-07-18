/**
 * CPC registry entry — pure metadata + factory (re-architecture §3.5).
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type { MachineDescriptor, MachineEntry, MachineUiCapabilities } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { CpcModel } from './models.ts';
import { cpcHasDisk } from './models.ts';
import { CpcMachine } from './cpc-machine.ts';
import { CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT, CPC_BORDER_LEFT, CPC_BORDER_TOP } from './constants.ts';

function cpcUi(model: MachineModel): MachineUiCapabilities {
  return {
    // Sysvars and fonts read Spectrum-specific memory layouts and stay hidden;
    // BASIC variables are parsed from Locomotive BASIC's own tables (see the
    // frame probe), so that pane is available.
    hiddenPanes: ['sysvar-panel', 'font-panel'],
    memoryLayout: true,
    trace: false,
    colorMap: 'cpc',
    builtinDisk: cpcHasDisk(model),
    joystick: true,
    fixedJoystick: true,
    mouse: true,
    cartridge: false,
    systemRomLabel: 'ROM',
    romPages: 0,
    beeper: false,
    kempston: false,
    tapeEar: false,
    rainbow: false,
    keyboardBus: 'ppi',
    tape: 'deck',
    tapeSound: false,
    tapeExtensions: ['.cdt', '.tzx', '.tap', '.zip'],
    saveMenu: 'cpc',
    zipPolicy: 'none',
    persistMedia: false,
    bootDisk: false,
    library: false,
    memoryRegions: [
      { value: 'cpcRomLower', label: 'ROM Lower (OS)' },
      { value: 'cpcRomBasic', label: 'ROM BASIC' },
      { value: 'cpcRomAmsdos', label: 'ROM AMSDOS' },
    ],
    charset: 'cpc',
  };
}

// Concatenated to OS(16KB) + BASIC(16KB) [+ AMSDOS(16KB)] — the layout
// CpcMemory.loadROM() splits on.
const ROM_SOURCES: Record<CpcModel, string[]> = {
  cpc6128: ['os6128.rom', 'basic1-1.rom', 'amsdos.rom'],
  cpc664:  ['os664.rom', 'basic664.rom', 'amsdos.rom'],
  cpc464:  ['os464.rom', 'basic1-0.rom'],
};

/** Descriptor for one CPC model — shared by the registry entry and the machine
 *  instance's own `descriptor` getter. */
export function cpcDescriptor(model: MachineModel): MachineDescriptor {
  return {
    kind: 'cpc',
    model,
    cpuFamily: 'z80',
    // The CPC frame buffer is 2× oversampled horizontally (16 Gate-Array
    // pixel clocks per character); display at half width to restore ~4:3.
    screen: {
      width: CPC_SCREEN_WIDTH, height: CPC_SCREEN_HEIGHT, pixelAspectX: 0.5,
      activeWidth: 640, activeHeight: 200,
      borderLeft: CPC_BORDER_LEFT, borderTop: CPC_BORDER_TOP,
    },
    ui: cpcUi(model),
  };
}

export const cpcEntry: MachineEntry = {
  kind: 'cpc',
  models: ['cpc464', 'cpc664', 'cpc6128'],
  descriptor: cpcDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new CpcMachine(model as CpcModel, display);
  },
  romSources(model: MachineModel) {
    return ROM_SOURCES[model as CpcModel];
  },
};
