import { M6502DebugService } from '@/debug/m6502/service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import type { Apple2Machine } from '../apple2-machine.ts';
import { Apple2FrameProbe } from './frame-probe.ts';
import { Apple2InputService } from './input.ts';
import { Apple2MediaService } from './media.ts';
import { Apple2RomService } from './roms.ts';
import { Apple2DiskService } from './disks.ts';
import { Apple2TapeService } from './tape.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { APPLE2_STATE_SPEC } from '../snapshots/apple2-state.ts';

export interface Apple2Services extends MachineServices {
  readonly media: Apple2MediaService;
  readonly roms: Apple2RomService;
  readonly tape: Apple2TapeService;
  readonly disks: Apple2DiskService;
  readonly snapshots: NativeSnapshotService;
  readonly input: Apple2InputService;
  readonly probe: Apple2FrameProbe;
}

export function createApple2Services(machine: Apple2Machine): Apple2Services {
  const roms = new Apple2RomService(machine, () => machine.host);
  const disks = new Apple2DiskService(machine);
  const tape = new Apple2TapeService(machine);
  const snapshots = new NativeSnapshotService(APPLE2_STATE_SPEC, machine, () => machine.host);
  return {
    media: new Apple2MediaService(machine, disks, tape, snapshots),
    roms,
    tape,
    disks,
    snapshots,
    input: new Apple2InputService(machine),
    probe: new Apple2FrameProbe(machine),
    debug: new M6502DebugService(machine),
  };
}
