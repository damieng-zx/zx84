/**
 * Assembles the Jupiter Ace's service surface.
 * The Ace has no floppy drive, so `disks` is null. Snapshots are zx84's own
 * `.acestate` plus xAce's `.ace` (load only).
 */

import type { MachineServices } from '@/machines/machine.ts';
import type { JupiterAceMachine } from '../ace-machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import { AceInputService } from './input.ts';
import { AceTapeService } from './tape.ts';
import { AceRomService } from './roms.ts';
import { AceMediaService } from './media.ts';
import { AceFrameProbe } from './frame-probe.ts';
import { AceSnapshotService } from './snapshots.ts';

export interface AceServices extends MachineServices {
  readonly media: AceMediaService;
  readonly roms: AceRomService;
  readonly tape: AceTapeService;
  readonly disks: null;
  readonly snapshots: AceSnapshotService;
  readonly input: AceInputService;
  readonly probe: AceFrameProbe;
}

export function createAceServices(m: JupiterAceMachine): AceServices {
  const host = () => m.host;
  const tape = new AceTapeService(m);
  const roms = new AceRomService(m, host);
  const snapshots = new AceSnapshotService(m, host);
  const media = new AceMediaService(tape, snapshots);
  return {
    media, roms, tape, disks: null, snapshots,
    input: new AceInputService(m),
    probe: new AceFrameProbe(m),
    debug: new Z80DebugService(m),
  };
}
