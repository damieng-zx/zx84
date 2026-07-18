/**
 * Spectrum registry entry — pure metadata + factory (re-architecture §3.5).
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/display.ts';
import type { MachineDescriptor, MachineEntry } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { SpectrumModel } from './models.ts';
import { Spectrum } from './spectrum.ts';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './ula.ts';
import { ROM_BASE } from '@/utils/rom-host.ts';

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
      screen: { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, pixelAspectX: 1 },
    };
  },
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new Spectrum(model as SpectrumModel, display);
  },
  romSources(model: MachineModel) {
    return ROM_SOURCES[model as SpectrumModel];
  },
};
