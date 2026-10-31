import { Z80DebugService } from '@/debug/z80/service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import type { MtxMachine } from '../mtx-machine.ts';
import { MtxFrameProbe } from './frame-probe.ts';
import { MtxInputService } from './input.ts';
import { MtxMediaService } from './media.ts';
import { MtxRomService } from './roms.ts';
import { MtxTapeService } from './tape.ts';
import { MtxDiskService } from './disks.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { MTX_STATE } from '../snapshots/mtx-state.ts';

export interface MtxServices extends MachineServices {
  readonly media: MtxMediaService;
  readonly roms: MtxRomService;
  readonly tape: MtxTapeService;
  readonly disks: MtxDiskService;
  readonly snapshots: NativeSnapshotService;
  readonly input: MtxInputService;
  readonly probe: MtxFrameProbe;
}

export function createMtxServices(machine: MtxMachine): MtxServices {
  const tape = new MtxTapeService(machine);
  const disks = new MtxDiskService(machine);
  const roms = new MtxRomService(machine, () => machine.host);
  const snapshots = new NativeSnapshotService(MTX_STATE, machine, () => machine.host);
  return {
    media: new MtxMediaService(tape, disks, roms, snapshots),
    roms,
    tape,
    disks,
    snapshots,
    input: new MtxInputService(machine),
    probe: new MtxFrameProbe(machine),
    debug: new Z80DebugService(machine),
  };
}
