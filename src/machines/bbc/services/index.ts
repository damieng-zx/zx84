import { M6502DebugService } from '@/debug/m6502/service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import type { BbcMachine } from '../bbc-machine.ts';
import { BbcFrameProbe } from './frame-probe.ts';
import { BbcInputService } from './input.ts';
import { BbcMediaService } from './media.ts';
import { BbcRomService } from './roms.ts';
import { BbcDiskService } from './disks.ts';
import { AcornTapeService } from '@/machines/shared/acorn-tape-service.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { BBC_STATE_SPEC } from '../snapshots/bbc-state.ts';

export interface BbcServices extends MachineServices {
  readonly media: BbcMediaService;
  readonly roms: BbcRomService;
  readonly tape: AcornTapeService;
  readonly disks: BbcDiskService;
  readonly snapshots: NativeSnapshotService;
  readonly input: BbcInputService;
  readonly probe: BbcFrameProbe;
}

export function createBbcServices(machine: BbcMachine): BbcServices {
  const roms = new BbcRomService(machine, () => machine.host);
  const disks = new BbcDiskService(machine);
  const tape = new AcornTapeService(machine.cassette, 'bbc-tape.uef');
  const snapshots = new NativeSnapshotService(BBC_STATE_SPEC, machine, () => machine.host);
  return {
    media: new BbcMediaService(machine, disks, tape, snapshots),
    roms,
    tape,
    disks,
    snapshots,
    input: new BbcInputService(machine),
    probe: new BbcFrameProbe(machine),
    debug: new M6502DebugService(machine),
  };
}
