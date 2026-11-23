/**
 * The C128's service surface: the Datasette, the disk drives on the serial
 * bus, programs and snapshots through media, the ROMs, and the debugger over
 * both CPUs (the 8502 and the Z80).
 */

import type { MachineServices } from '@/machines/machine.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import type { C128Machine } from '../c128-machine.ts';
import { C128_STATE } from '../snapshots/c128-state.ts';
import { CbmDiskService } from '@/machines/shared/cbm/disk-service.ts';
import { CbmTapeService } from '@/machines/shared/cbm/tape-service.ts';
import { tapFormat } from '@/media/tape/c64-tap.ts';
import { C128DebugService } from './debug.ts';
import { C128FrameProbe } from './frame-probe.ts';
import { C128Inspection } from './inspect.ts';
import { C128InputService } from './input.ts';
import { C128MediaService } from './media.ts';
import { C128RomService } from './roms.ts';

export interface C128Services extends MachineServices {
  readonly media: C128MediaService;
  readonly roms: C128RomService;
  readonly tape: CbmTapeService;
  readonly disks: CbmDiskService;
  readonly snapshots: NativeSnapshotService;
  readonly input: C128InputService;
  readonly probe: C128FrameProbe;
  readonly inspect: C128Inspection;
}

export function createC128Services(m: C128Machine): C128Services {
  // An NTSC machine records in its own cycles, and says so in the .tap's header.
  // A BASIC program taped from BASIC 7.0 starts at $1C01, the 64's at $0801.
  const tape = new CbmTapeService(m, {
    fallbackName: 'c128',
    format: tapFormat(0, m.timing.ntsc ? 1 : 0),
    basicStarts: [0x0801, 0x1C01],
  });
  const disks = new CbmDiskService(m.iec, () => m.host);
  const snapshots = new NativeSnapshotService(C128_STATE, m, () => m.host);
  return {
    media: new C128MediaService(m, tape, disks, snapshots),
    roms: new C128RomService(m, () => m.host),
    tape,
    disks,
    snapshots,
    input: new C128InputService(m),
    probe: new C128FrameProbe(m),
    inspect: new C128Inspection(m),
    debug: new C128DebugService(m),
  };
}
