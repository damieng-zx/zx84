/**
 * Assembles the CPC's service surface (§3.3 of docs/re-architecture.md).
 * Constructed once per machine; the shell/MCP reach machine internals only
 * through these.
 */

import type { MachineServices } from '@/machines/machine.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { CpcInputService } from './input.ts';
import { CpcTapeService } from './tape.ts';
import { CpcDiskService } from './disks.ts';
import { CpcRomService } from './roms.ts';
import { CpcSnapshotService } from './snapshots.ts';
import { CpcMediaService } from './media.ts';
import { CpcFrameProbe } from './frame-probe.ts';

export interface CpcServices extends MachineServices {
  readonly media: CpcMediaService;
  readonly roms: CpcRomService;
  readonly tape: CpcTapeService;
  readonly disks: CpcDiskService;
  readonly snapshots: CpcSnapshotService;
  readonly input: CpcInputService;
  readonly probe: CpcFrameProbe;
}

export function createCpcServices(c: CpcMachine): CpcServices {
  const host = () => c.host;
  const tape = new CpcTapeService(c);
  const disks = new CpcDiskService(c);
  const roms = new CpcRomService(host);
  const snapshots = new CpcSnapshotService(c, host);
  const media = new CpcMediaService(c, disks, tape, snapshots);
  return {
    media, roms, tape, disks, snapshots,
    input: new CpcInputService(c),
    probe: new CpcFrameProbe(c),
  };
}
