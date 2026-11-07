/**
 * The VIC-20's service surface: the ROMs, the Datasette, the serial-bus disk
 * drives, programs and snapshots through media, input, the frame probe and
 * the 6502 debug family.
 */

import type { MachineServices } from '@/machines/machine.ts';
import { M6502DebugService } from '@/debug/m6502/service.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { CbmTapeService } from '@/machines/shared/cbm/tape-service.ts';
import { CbmDiskService } from '@/machines/shared/cbm/disk-service.ts';
import { tapFormat } from '@/media/tape/c64-tap.ts';
import type { Vic20Machine } from '../vic20-machine.ts';
import { VIC20_STATE } from '../snapshots/vic20-state.ts';
import { Vic20FrameProbe } from './frame-probe.ts';
import { Vic20InputService } from './input.ts';
import { Vic20MediaService } from './media.ts';
import { Vic20RomService } from './roms.ts';

export interface Vic20Services extends MachineServices {
  readonly media: Vic20MediaService;
  readonly roms: Vic20RomService;
  readonly tape: CbmTapeService;
  readonly disks: CbmDiskService;
  readonly snapshots: NativeSnapshotService;
  readonly input: Vic20InputService;
  readonly probe: Vic20FrameProbe;
}

export function createVic20Services(m: Vic20Machine): Vic20Services {
  const snapshots = new NativeSnapshotService(VIC20_STATE, m, () => m.host);
  // A VIC-20 .tap counts VIC-20 cycles and says so (platform 1); a program at
  // any of BASIC's three starting places is taped as relocatable.
  const tape = new CbmTapeService(m, {
    fallbackName: 'vic20',
    format: tapFormat(1, m.timing.ntsc ? 1 : 0),
    basicStarts: [0x0401, 0x1001, 0x1201],
  });
  const disks = new CbmDiskService(m.iec, () => m.host);
  return {
    media: new Vic20MediaService(m, tape, disks, snapshots),
    roms: new Vic20RomService(m, () => m.host),
    tape,
    disks,
    snapshots,
    input: new Vic20InputService(m),
    probe: new Vic20FrameProbe(m),
    debug: new M6502DebugService(m),
  };
}
