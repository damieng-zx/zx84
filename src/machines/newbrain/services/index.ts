/**
 * Assembles the NewBrain's service surface. The unexpanded machine has no
 * disks, and it has no native snapshot yet.
 */

import type { MachineHost, MachineServices } from '@/machines/machine.ts';
import type { NewBrainMachine } from '../newbrain-machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import { NewBrainInputService } from './input.ts';
import { NewBrainTapeService } from './tape.ts';
import { NewBrainRomService } from './roms.ts';
import { NewBrainMediaService } from './media.ts';
import { NewBrainFrameProbe } from './frame-probe.ts';

export interface NewBrainServices extends MachineServices {
  readonly media: NewBrainMediaService;
  readonly roms: NewBrainRomService;
  readonly tape: NewBrainTapeService;
  readonly disks: null;
  readonly snapshots: null;
  readonly input: NewBrainInputService;
  readonly probe: NewBrainFrameProbe;
}

export function createNewBrainServices(
  m: NewBrainMachine,
  host: () => MachineHost | null,
): NewBrainServices {
  const tape = new NewBrainTapeService(m);
  return {
    media: new NewBrainMediaService(tape),
    roms: new NewBrainRomService(m, host),
    tape,
    disks: null,
    snapshots: null,
    input: new NewBrainInputService(m),
    probe: new NewBrainFrameProbe(m),
    debug: new Z80DebugService(m),
  };
}
