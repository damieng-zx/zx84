/**
 * Assembles the MSX's service surface.
 * The disks service is always present: its drive list is empty until the
 * optional floppy disk interface is fitted. There is no snapshot format, so
 * `snapshots` is null.
 */

import type { MachineServices } from '@/machines/machine.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import { MsxInputService } from './input.ts';
import { MsxTapeService } from './tape.ts';
import { MsxRomService } from './roms.ts';
import { MsxMediaService } from './media.ts';
import { MsxDiskService } from './disks.ts';
import { MsxFrameProbe } from './frame-probe.ts';

export interface MsxServices extends MachineServices {
  readonly media: MsxMediaService;
  readonly roms: MsxRomService;
  readonly tape: MsxTapeService;
  readonly disks: MsxDiskService;
  readonly snapshots: null;
  readonly input: MsxInputService;
  readonly probe: MsxFrameProbe;
}

export function createMsxServices(m: MsxMachine): MsxServices {
  const host = () => m.host;
  const tape = new MsxTapeService(m);
  const roms = new MsxRomService(m, host);
  const disks = new MsxDiskService(m);
  const media = new MsxMediaService(roms, tape, disks);
  return {
    media, roms, tape, disks, snapshots: null,
    input: new MsxInputService(m),
    probe: new MsxFrameProbe(m),
    debug: new Z80DebugService(m),
  };
}
