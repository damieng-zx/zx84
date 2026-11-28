/**
 * Assembles the CPC's service surface.
 * Constructed once per machine; the shell/MCP reach machine internals only
 * through these.
 */

import type { MachineServices } from '@/machines/machine.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import { CpcInputService } from './input.ts';
import { cpcTapeService } from './tape.ts';
import type { DeckTapeService } from '@/machines/shared/deck-tape-service.ts';
import { CpcDiskService } from './disks.ts';
import { CpcRomService } from './roms.ts';
import { CpcSnapshotService } from './snapshots.ts';
import { CpcMediaService } from './media.ts';
import { CpcFrameProbe } from './frame-probe.ts';
import { CpcInspection } from './inspect.ts';

export interface CpcServices extends MachineServices {
  readonly media: CpcMediaService;
  readonly roms: CpcRomService;
  readonly tape: DeckTapeService;
  readonly disks: CpcDiskService;
  readonly snapshots: CpcSnapshotService;
  readonly input: CpcInputService;
  readonly probe: CpcFrameProbe;
  readonly inspect: CpcInspection;
}

export function createCpcServices(c: CpcMachine): CpcServices {
  const host = () => c.host;
  const tape = cpcTapeService(c);
  const disks = new CpcDiskService(c);
  const roms = new CpcRomService(c, host);
  const snapshots = new CpcSnapshotService(c, host);
  const media = new CpcMediaService(c, disks, tape, snapshots, roms);
  return {
    media, roms, tape, disks, snapshots,
    input: new CpcInputService(c),
    probe: new CpcFrameProbe(c),
    inspect: new CpcInspection(c),
    debug: new Z80DebugService(c),
  };
}
