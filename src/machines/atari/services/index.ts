/**
 * Assembles the Atari service surface — the only way the shell, UI and MCP
 * server reach the machine's internals.
 *
 * Two drives (D1:/D2:, of the selected model) and the program recorder are
 * served through the native SIO fast path. Snapshots are zx84's own `.a8state`
 * (snapshots/atari-state.ts); no other emulator's format is read or written.
 */

import { M6502DebugService } from '@/debug/m6502/service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import type { AtariMachine } from '../atari-machine.ts';
import { AtariDiskService } from './disks.ts';
import { AtariFrameProbe } from './frame-probe.ts';
import { AtariInputService } from './input.ts';
import { AtariMediaService } from './media.ts';
import { AtariRomService } from './roms.ts';
import { AtariSnapshotService } from './snapshots.ts';
import { AtariTapeService } from './tape.ts';

export interface AtariServices extends MachineServices {
  readonly media: AtariMediaService;
  readonly roms: AtariRomService;
  readonly tape: AtariTapeService;
  readonly disks: AtariDiskService;
  readonly snapshots: AtariSnapshotService;
  readonly input: AtariInputService;
  readonly probe: AtariFrameProbe;
}

export function createAtariServices(machine: AtariMachine): AtariServices {
  const roms = new AtariRomService(machine, () => machine.host);
  const disks = new AtariDiskService();
  const tape = new AtariTapeService(machine);
  return {
    media: new AtariMediaService(roms, disks, tape, machine),
    roms,
    disks,
    tape,
    snapshots: new AtariSnapshotService(machine, () => machine.host),
    input: new AtariInputService(machine),
    probe: new AtariFrameProbe(machine),
    debug: new M6502DebugService(machine),
  };
}
