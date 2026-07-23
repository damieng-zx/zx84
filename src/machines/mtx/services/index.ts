import { Z80DebugService } from '@/debug/z80/service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import type { MtxMachine } from '../mtx-machine.ts';
import { MtxFrameProbe } from './frame-probe.ts';
import { MtxInputService } from './input.ts';
import { MtxMediaService } from './media.ts';
import { MtxRomService } from './roms.ts';
import { MtxTapeService } from './tape.ts';
import { MtxDiskService } from './disks.ts';

export interface MtxServices extends MachineServices {
  readonly media: MtxMediaService;
  readonly roms: MtxRomService;
  readonly tape: MtxTapeService;
  readonly disks: MtxDiskService;
  readonly snapshots: null;
  readonly input: MtxInputService;
  readonly probe: MtxFrameProbe;
}

export function createMtxServices(machine: MtxMachine): MtxServices {
  const tape = new MtxTapeService(machine);
  const disks = new MtxDiskService(machine);
  const roms = new MtxRomService(machine, () => machine.host);
  return {
    media: new MtxMediaService(tape, disks, roms),
    roms,
    tape,
    disks,
    snapshots: null,
    input: new MtxInputService(machine),
    probe: new MtxFrameProbe(machine),
    debug: new Z80DebugService(machine),
  };
}
