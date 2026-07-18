/**
 * Assembles the MSX's service surface (§3.3 of docs/re-architecture.md).
 * The HX-10 has no floppy drive and no snapshot format, so `disks` and
 * `snapshots` are null.
 */

import type { MachineServices } from '@/machines/machine.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import { MsxInputService } from './input.ts';
import { MsxTapeService } from './tape.ts';
import { MsxRomService } from './roms.ts';
import { MsxMediaService } from './media.ts';
import { MsxFrameProbe } from './frame-probe.ts';

export interface MsxServices extends MachineServices {
  readonly media: MsxMediaService;
  readonly roms: MsxRomService;
  readonly tape: MsxTapeService;
  readonly disks: null;
  readonly snapshots: null;
  readonly input: MsxInputService;
  readonly probe: MsxFrameProbe;
}

export function createMsxServices(m: MsxMachine): MsxServices {
  const host = () => m.host;
  const tape = new MsxTapeService(m);
  const roms = new MsxRomService(m, host);
  const media = new MsxMediaService(roms, tape);
  return {
    media, roms, tape, disks: null, snapshots: null,
    input: new MsxInputService(m),
    probe: new MsxFrameProbe(m),
    debug: new Z80DebugService(m),
  };
}
