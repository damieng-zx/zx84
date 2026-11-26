/**
 * The Plus/4's service surface: the ROMs, the Datasette, the serial-bus disk
 * drives, programs and snapshots through media, input, the frame probe and the
 * 6502 debug family.
 *
 * The tape's format byte says the pulses count C16/Plus/4 cycles (VICE's
 * platform 2); the C16 writes the same format as the Plus/4 (both are the
 * "Ted" machines), which is what tap.h's `TAP_HDR_SYSTEM_C16` means.
 */

import type { MachineServices } from '@/machines/machine.ts';
import { M6502DebugService } from '@/debug/m6502/service.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { CbmTapeService } from '@/machines/shared/cbm/tape-service.ts';
import { CbmDiskService } from '@/machines/shared/cbm/disk-service.ts';
import { tapFormat } from '@/media/tape/c64-tap.ts';
import type { Plus4Machine } from '../plus4-machine.ts';
import { PLUS4_STATE } from '../snapshots/plus4-state.ts';
import { Plus4FrameProbe } from './frame-probe.ts';
import { Plus4Inspection } from './inspect.ts';
import { Plus4InputService } from './input.ts';
import { Plus4MediaService } from './media.ts';
import { Plus4RomService } from './roms.ts';

export interface Plus4Services extends MachineServices {
  readonly media: Plus4MediaService;
  readonly roms: Plus4RomService;
  readonly tape: CbmTapeService;
  readonly disks: CbmDiskService;
  readonly snapshots: NativeSnapshotService;
  readonly input: Plus4InputService;
  readonly probe: Plus4FrameProbe;
  readonly inspect: Plus4Inspection;
}

export function createPlus4Services(m: Plus4Machine): Plus4Services {
  const snapshots = new NativeSnapshotService(PLUS4_STATE, m, () => m.host);
  // A Plus/4 .tap counts Plus/4 cycles and says so (platform 2); a program at
  // either of BASIC 3.5's two starting places is taped as relocatable.
  const tape = new CbmTapeService(m, {
    fallbackName: m.model === 'c16' ? 'c16' : 'plus4',
    format: tapFormat(2, m.timing.ntsc ? 1 : 0),
    basicStarts: [0x1001, 0x4001],
  });
  const disks = new CbmDiskService(m.iec, () => m.host);
  return {
    media: new Plus4MediaService(m, tape, disks, snapshots),
    roms: new Plus4RomService(m, () => m.host),
    tape,
    disks,
    snapshots,
    input: new Plus4InputService(m),
    probe: new Plus4FrameProbe(m),
    inspect: new Plus4Inspection(m),
    debug: new M6502DebugService(m),
  };
}
