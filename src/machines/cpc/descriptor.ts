/**
 * CPC registry entry — pure metadata + factory (re-architecture §3.5).
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/display.ts';
import type { MachineDescriptor, MachineEntry } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { CpcModel } from './models.ts';
import { CpcMachine } from './cpc-machine.ts';
import { CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT } from './constants.ts';
import { ROM_BASE } from '@/utils/rom-host.ts';

// Concatenated to OS(16KB) + BASIC(16KB) [+ AMSDOS(16KB)] — the layout
// CpcMemory.loadROM() splits on.
const ROM_SOURCES: Record<CpcModel, string[]> = {
  cpc6128: [`${ROM_BASE}os6128.rom`, `${ROM_BASE}basic1-1.rom`, `${ROM_BASE}amsdos.rom`],
  cpc664:  [`${ROM_BASE}os664.rom`, `${ROM_BASE}basic664.rom`, `${ROM_BASE}amsdos.rom`],
  cpc464:  [`${ROM_BASE}os464.rom`, `${ROM_BASE}basic1-0.rom`],
};

export const cpcEntry: MachineEntry = {
  kind: 'cpc',
  models: ['cpc464', 'cpc664', 'cpc6128'],
  descriptor(model: MachineModel): MachineDescriptor {
    return {
      kind: 'cpc',
      model,
      cpuFamily: 'z80',
      // The CPC frame buffer is 2× oversampled horizontally (16 Gate-Array
      // pixel clocks per character); display at half width to restore ~4:3.
      screen: { width: CPC_SCREEN_WIDTH, height: CPC_SCREEN_HEIGHT, pixelAspectX: 0.5 },
    };
  },
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new CpcMachine(model as CpcModel, display);
  },
  romSources(model: MachineModel) {
    return ROM_SOURCES[model as CpcModel];
  },
};
