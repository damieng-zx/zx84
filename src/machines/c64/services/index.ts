/**
 * The C64's service surface: the Datasette, the 1541 disk drive, programs and
 * snapshots through media, the ROMs, and the 6502 debug family.
 */

import type { MachineServices } from '@/machines/machine.ts';
import { M6502DebugService } from '@/debug/m6502/service.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import type { C64Machine } from '../c64-machine.ts';
import { C64_STATE } from '../snapshots/c64-state.ts';
import { CbmDiskService } from '@/machines/shared/cbm/disk-service.ts';
import { CbmTapeService } from '@/machines/shared/cbm/tape-service.ts';
import { C64FrameProbe } from './frame-probe.ts';
import { C64InputService } from './input.ts';
import { C64MediaService } from './media.ts';
import { C64RomService } from './roms.ts';

export interface C64Services extends MachineServices {
  readonly media: C64MediaService;
  readonly roms: C64RomService;
  readonly tape: CbmTapeService;
  readonly disks: CbmDiskService;
  readonly snapshots: NativeSnapshotService;
  readonly input: C64InputService;
  readonly probe: C64FrameProbe;
}

export function createC64Services(m: C64Machine): C64Services {
  const tape = new CbmTapeService(m, 'c64');
  const disks = new CbmDiskService(m.iec, () => m.host);
  const snapshots = new NativeSnapshotService(C64_STATE, m, () => m.host);
  return {
    media: new C64MediaService(m, tape, disks, snapshots),
    roms: new C64RomService(m, () => m.host),
    tape,
    disks,
    snapshots,
    input: new C64InputService(m),
    probe: new C64FrameProbe(m),
    debug: new M6502DebugService(m),
  };
}
