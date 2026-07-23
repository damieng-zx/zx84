import { Z80DebugService } from '@/debug/z80/service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import type { MtxMachine } from '../mtx-machine.ts';
import { MtxFrameProbe } from './frame-probe.ts';
import { MtxInputService } from './input.ts';
import { MtxMediaService } from './media.ts';
import { MtxRomService } from './roms.ts';

export interface MtxServices extends MachineServices {
  readonly media: MtxMediaService;
  readonly roms: MtxRomService;
  readonly tape: null;
  readonly disks: null;
  readonly snapshots: null;
  readonly input: MtxInputService;
  readonly probe: MtxFrameProbe;
}

export function createMtxServices(machine: MtxMachine): MtxServices {
  return {
    media: new MtxMediaService(),
    roms: new MtxRomService(machine, () => machine.host),
    tape: null,
    disks: null,
    snapshots: null,
    input: new MtxInputService(machine),
    probe: new MtxFrameProbe(machine),
    debug: new Z80DebugService(machine),
  };
}
