import { M6502DebugService } from '@/debug/m6502/service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import type { Apple1Machine } from '../apple1-machine.ts';
import { Apple1FrameProbe } from './frame-probe.ts';
import { Apple1InputService } from './input.ts';
import { Apple1MediaService } from './media.ts';
import { Apple1RomService } from './roms.ts';
import { Apple1TapeService } from './tape.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { APPLE1_STATE_SPEC } from '../snapshots/apple1-state.ts';

export interface Apple1Services extends MachineServices {
  readonly media: Apple1MediaService;
  readonly roms: Apple1RomService;
  /** The cassette deck, or null while the Apple Cassette Interface is not fitted. */
  readonly tape: Apple1TapeService | null;
  readonly disks: null;
  readonly snapshots: NativeSnapshotService;
  readonly input: Apple1InputService;
  readonly probe: Apple1FrameProbe;
}

export function createApple1Services(machine: Apple1Machine): Apple1Services {
  const tape = new Apple1TapeService(machine);
  const snapshots = new NativeSnapshotService(APPLE1_STATE_SPEC, machine, () => machine.host);
  return {
    media: new Apple1MediaService(machine, tape, snapshots),
    roms: new Apple1RomService(machine, () => machine.host),
    // The deck exists only with the interface, which is fitted when the machine is prepared.
    get tape() { return machine.options.aci ? tape : null; },
    disks: null,
    snapshots,
    input: new Apple1InputService(machine),
    probe: new Apple1FrameProbe(machine),
    debug: new M6502DebugService(machine),
  };
}
