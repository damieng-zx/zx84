/**
 * Assembles the SAM Coupé's service surface — the only way the shell, UI and
 * MCP server reach machine internals.
 *
 * Services for hardware that is not fitted yet return `null`, which the SPI
 * treats as "this machine hasn't got one" and the generic panes hide
 * themselves accordingly. Snapshots are the last remaining null.
 */

import type { MachineServices, SnapshotService } from '@/machines/machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import type { SamMachine } from '../sam-machine.ts';
import { SamMediaService } from './media.ts';
import { SamRomService } from './roms.ts';
import { SamInputService } from './input.ts';
import { SamFrameProbe } from './frame-probe.ts';
import { SamDiskService } from './disks.ts';
import { SamTapeService } from './tape.ts';

export interface SamServices extends MachineServices {
  readonly media: SamMediaService;
  readonly roms: SamRomService;
  readonly input: SamInputService;
  readonly probe: SamFrameProbe;
  readonly disks: SamDiskService;
  readonly tape: SamTapeService;
  readonly snapshots: SnapshotService | null;
}

export function createSamServices(m: SamMachine): SamServices {
  const disks = new SamDiskService(m);
  const tape = new SamTapeService(m);
  return {
    media: new SamMediaService(m, disks, tape),
    roms: new SamRomService(m, () => m.host),
    disks,
    tape,
    snapshots: null,
    input: new SamInputService(m),
    probe: new SamFrameProbe(m),
    debug: new Z80DebugService(m),
  };
}
