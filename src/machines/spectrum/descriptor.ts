/**
 * Spectrum registry entry — pure metadata + factory (re-architecture §3.5).
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/display.ts';
import type { MachineDescriptor, MachineEntry, MachineUiCapabilities, MemoryRegionInfo } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { SpectrumModel } from './models.ts';
import { is128kClass, isPlus2AClass, isPlus3, isInterface2Capable, romPageSlotCount } from './models.ts';
import { Spectrum } from './spectrum.ts';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './ula.ts';
import { ROM_BASE } from '@/utils/rom-host.ts';

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
  '16k':  [`${ROM_BASE}48.rom`],
  '48k':  [`${ROM_BASE}48.rom`],
  '128k': [`${ROM_BASE}128-0.rom`, `${ROM_BASE}128-1.rom`],
  '+2':   [`${ROM_BASE}plus2-0.rom`, `${ROM_BASE}plus2-1.rom`],
  '+2A':  [`${ROM_BASE}plus3-41-0.rom`, `${ROM_BASE}plus3-41-1.rom`, `${ROM_BASE}plus3-41-2.rom`, `${ROM_BASE}plus3-41-3.rom`],
  '+3':   [`${ROM_BASE}plus3-0.rom`, `${ROM_BASE}plus3-1.rom`, `${ROM_BASE}plus3-2.rom`, `${ROM_BASE}plus3-3.rom`],
};

export const spectrumEntry: MachineEntry = {
  kind: 'spectrum',
  models: ['16k', '48k', '128k', '+2', '+2A', '+3'],
  descriptor(model: MachineModel): MachineDescriptor {
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
  },
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new Spectrum(model as SpectrumModel, display);
  },
  romSources(model: MachineModel) {
    return ROM_SOURCES[model as SpectrumModel];
  },
};
