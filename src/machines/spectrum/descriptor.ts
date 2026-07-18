/**
 * Spectrum registry entry — pure metadata + factory (re-architecture §3.5).
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/renderer.ts';
import type { MachineDescriptor, MachineEntry, MachineUiCapabilities, MemoryRegionInfo } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { isCpcModel } from '@/models.ts';
import type { SpectrumModel } from './models.ts';
import { is128kClass, isPlus2AClass, isPlus3, isInterface2Capable, romPageSlotCount } from './models.ts';
import { Spectrum } from './spectrum.ts';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './ula.ts';

// The Spectrum active display is 256×192; the full ("Normal") border is 48px on
// every side (SCREEN_WIDTH/HEIGHT = 256/192 + 48·2). The border-size crop is
// applied generically by Screen.tsx.
const SPECTRUM_BORDER = 48;

/** ROM regions the Memory pane offers: one entry per 16K system-ROM page. */
function spectrumMemoryRegions(model: MachineModel): MemoryRegionInfo[] {
  const romCount = isPlus2AClass(model) ? 4 : is128kClass(model) ? 2 : 1;
  return Array.from({ length: romCount }, (_, i) => ({ value: `rom${i}`, label: `ROM ${i}` }));
}

function spectrumUi(model: MachineModel): MachineUiCapabilities {
  return {
    hiddenPanes: [],
    memoryLayout: is128kClass(model),
    trace: true,
    colorMap: 'spectrum',
    builtinDisk: isPlus3(model),
    joystick: true,
    fixedJoystick: false,
    mouse: true,
    cartridge: isInterface2Capable(model),
    systemRomLabel: 'ROM',
    romPages: romPageSlotCount(model),
    beeper: true,
    kempston: true,
    tapeEar: true,
    rainbow: true,
    keyboardBus: 'ula',
    tape: 'deck',
    tapeSound: true,
    tapeExtensions: ['.tap', '.tzx', '.csw', '.zip'],
    saveMenu: 'spectrum',
    zipPolicy: 'all',
    persistMedia: true,
    bootDisk: false,
    library: true,
    memoryRegions: spectrumMemoryRegions(model),
    charset: 'spectrum',
  };
}

// Each model lists its ROM pages in order; they are fetched and concatenated
// by the shared rom-manager machinery. The +3 is resolved to the +2A's v4.1
// set by the shell's effectiveROMModel() before lookup, but keep its own row
// so the table is total over the family.
const ROM_SOURCES: Record<SpectrumModel, string[]> = {
  '16k':  ['48.rom'],
  '48k':  ['48.rom'],
  '128k': ['128-0.rom', '128-1.rom'],
  '+2':   ['plus2-0.rom', 'plus2-1.rom'],
  '+2A':  ['plus3-41-0.rom', 'plus3-41-1.rom', 'plus3-41-2.rom', 'plus3-41-3.rom'],
  '+3':   ['plus3-0.rom', 'plus3-1.rom', 'plus3-2.rom', 'plus3-3.rom'],
};

/** Descriptor for one Spectrum model — shared by the registry entry and the
 *  machine instance's own `descriptor` getter. */
export function spectrumDescriptor(model: MachineModel): MachineDescriptor {
  return {
    kind: 'spectrum',
    model,
    cpuFamily: 'z80',
    screen: {
      width: SCREEN_WIDTH, height: SCREEN_HEIGHT, pixelAspectX: 1,
      activeWidth: 256, activeHeight: 192,
      borderLeft: SPECTRUM_BORDER, borderTop: SPECTRUM_BORDER,
    },
    ui: spectrumUi(model),
  };
}

export const spectrumEntry: MachineEntry = {
  kind: 'spectrum',
  models: ['16k', '48k', '128k', '+2', '+2A', '+3'],
  descriptor: spectrumDescriptor,
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new Spectrum(model as SpectrumModel, display);
  },
  romSources(model: MachineModel) {
    return ROM_SOURCES[model as SpectrumModel];
  },
  /** ROM-size → Spectrum model: a raw image always lands on a Spectrum (a CPC
   *  falls back to a 128K base), keeping the current model when its class
   *  already matches the image size. Ported verbatim from the shell's applyROM. */
  detectModelForRom(data: Uint8Array, current: MachineModel): MachineModel | null {
    const cur: SpectrumModel = isCpcModel(current) ? '128k' : current as SpectrumModel;
    if (data.length >= 65536) return isPlus2AClass(cur) ? cur : '+2A';
    if (data.length >= 32768) return is128kClass(cur) ? cur : '128k';
    if (data.length >= 16384) return '48k';
    return null;   // too small to be a system ROM
  },
};
