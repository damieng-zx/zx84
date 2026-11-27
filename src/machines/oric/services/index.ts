import { M6502DebugService } from '@/debug/m6502/service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import type { OricMachine } from '../oric-machine.ts';
import { ORIC_STATE_SPEC } from '../snapshots/oric-state.ts';
import { OricFrameProbe } from './frame-probe.ts';
import { OricInspection } from './inspect.ts';
import { OricInputService } from './input.ts';
import { OricMediaService } from './media.ts';
import { OricRomService } from './roms.ts';
import { OricTapeService } from './tape.ts';
import { OricDiskService } from './disks.ts';

export interface OricServices extends MachineServices {
  readonly media: OricMediaService;
  readonly roms: OricRomService;
  readonly tape: OricTapeService;
  /** The Microdisc's drives; empty while no card is fitted. */
  readonly disks: OricDiskService;
  readonly snapshots: NativeSnapshotService;
  readonly input: OricInputService;
  readonly probe: OricFrameProbe;
  readonly inspect: OricInspection;
}

export function createOricServices(machine: OricMachine): OricServices {
  const snapshots = new NativeSnapshotService(ORIC_STATE_SPEC, machine, () => machine.host);
  const tape = new OricTapeService(machine);
  const disks = new OricDiskService(machine);
  return {
    media: new OricMediaService(machine, tape, disks, snapshots),
    roms: new OricRomService(machine, () => machine.host),
    tape,
    disks,
    snapshots,
    input: new OricInputService(machine),
    probe: new OricFrameProbe(machine),
    inspect: new OricInspection(machine),
    debug: new M6502DebugService(machine),
  };
}
