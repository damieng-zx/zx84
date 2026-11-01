/**
 * The VIC-20's service surface: the ROMs, snapshots through media, input,
 * the frame probe and the 6502 debug family. The Datasette, the disk drives
 * and cartridges follow in the later phases of the plan.
 */

import type { MachineServices } from '@/machines/machine.ts';
import { M6502DebugService } from '@/debug/m6502/service.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import type { Vic20Machine } from '../vic20-machine.ts';
import { VIC20_STATE } from '../snapshots/vic20-state.ts';
import { Vic20FrameProbe } from './frame-probe.ts';
import { Vic20InputService } from './input.ts';
import { Vic20MediaService } from './media.ts';
import { Vic20RomService } from './roms.ts';

export interface Vic20Services extends MachineServices {
  readonly media: Vic20MediaService;
  readonly roms: Vic20RomService;
  readonly tape: null;
  readonly disks: null;
  readonly snapshots: NativeSnapshotService;
  readonly input: Vic20InputService;
  readonly probe: Vic20FrameProbe;
}

export function createVic20Services(m: Vic20Machine): Vic20Services {
  const snapshots = new NativeSnapshotService(VIC20_STATE, m, () => m.host);
  return {
    media: new Vic20MediaService(snapshots),
    roms: new Vic20RomService(m, () => m.host),
    tape: null,
    disks: null,
    snapshots,
    input: new Vic20InputService(m),
    probe: new Vic20FrameProbe(m),
    debug: new M6502DebugService(m),
  };
}
