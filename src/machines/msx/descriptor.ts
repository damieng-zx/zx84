/**
 * MSX registry entry — pure metadata + factory (re-architecture §3.5).
 * Imported only by `machines/registry.ts`; must stay headless-safe.
 */

import type { IScreenRenderer } from '@/display/display.ts';
import type { MachineDescriptor, MachineEntry } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { MsxModel } from './models.ts';
import { MsxMachine } from './msx-machine.ts';
import { MSX_SCREEN_WIDTH, MSX_SCREEN_HEIGHT } from './constants.ts';
import { ROM_BASE } from '@/utils/rom-host.ts';

export const msxEntry: MachineEntry = {
  kind: 'msx',
  models: ['hx-10'],
  descriptor(model: MachineModel): MachineDescriptor {
    return {
      kind: 'msx',
      model,
      cpuFamily: 'z80',
      screen: { width: MSX_SCREEN_WIDTH, height: MSX_SCREEN_HEIGHT, pixelAspectX: 1 },
    };
  },
  create(model: MachineModel, display: IScreenRenderer | null) {
    return new MsxMachine(model as MsxModel, display);
  },
  romSources() {
    return [`${ROM_BASE}hx-10_basic-bios1.rom`];
  },
};
