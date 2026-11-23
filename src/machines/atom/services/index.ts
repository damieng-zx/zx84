import { M6502DebugService } from '@/debug/m6502/service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import type { AtomMachine } from '../atom-machine.ts';
import type { AtomTape } from '../atom-tape.ts';
import { ATOM_STATE_SPEC } from '../snapshots/atom-state.ts';
import { AtomFrameProbe } from './frame-probe.ts';
import { AtomInspection } from './inspect.ts';
import { AtomInputService } from './input.ts';
import { AtomMediaService } from './media.ts';
import { AtomRomService } from './roms.ts';

export interface AtomServices extends MachineServices {
  readonly media: AtomMediaService;
  readonly roms: AtomRomService;
  readonly tape: AtomTape;
  readonly disks: null;
  readonly snapshots: NativeSnapshotService;
  readonly input: AtomInputService;
  readonly probe: AtomFrameProbe;
  readonly inspect: AtomInspection;
}

export function createAtomServices(machine: AtomMachine): AtomServices {
  const snapshots = new NativeSnapshotService(ATOM_STATE_SPEC, machine, () => machine.host);
  return {
    media: new AtomMediaService(machine, machine.tape, snapshots),
    roms: new AtomRomService(machine, () => machine.host),
    tape: machine.tape,
    disks: null,
    snapshots,
    input: new AtomInputService(machine),
    probe: new AtomFrameProbe(machine),
    inspect: new AtomInspection(machine),
    debug: new M6502DebugService(machine),
  };
}
