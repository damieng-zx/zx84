/**
 * Assembles the Jupiter Ace's service surface.
 * The Ace has no floppy drive, so `disks` is null. Snapshots are zx84's own
 * `.acestate` plus xAce's `.ace` (load only).
 */

import type { MachineServices } from '@/machines/machine.ts';
import type { JupiterAceMachine } from '../ace-machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import { AceInputService } from './input.ts';
import { aceTapeService } from './tape.ts';
import type { DeckTapeService } from '@/machines/shared/deck-tape-service.ts';
import { AceRomService } from './roms.ts';
import { AceMediaService } from './media.ts';
import { AceFrameProbe } from './frame-probe.ts';
import { AceInspection } from './inspect.ts';
import { AceSnapshotService } from './snapshots.ts';

export interface AceServices extends MachineServices {
  readonly media: AceMediaService;
  readonly roms: AceRomService;
  readonly tape: DeckTapeService;
  readonly disks: null;
  readonly snapshots: AceSnapshotService;
  readonly input: AceInputService;
  readonly probe: AceFrameProbe;
  readonly inspect: AceInspection;
}

export function createAceServices(m: JupiterAceMachine): AceServices {
  const host = () => m.host;
  const tape = aceTapeService(m);
  const roms = new AceRomService(m, host);
  const snapshots = new AceSnapshotService(m, host);
  const media = new AceMediaService(tape, snapshots);
  return {
    media, roms, tape, disks: null, snapshots,
    input: new AceInputService(m),
    probe: new AceFrameProbe(m),
    inspect: new AceInspection(m),
    debug: new Z80DebugService(m),
  };
}
