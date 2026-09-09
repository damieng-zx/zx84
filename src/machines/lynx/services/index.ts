/**
 * The Lynx's service surface. Tape, disks and snapshots are still null: the
 * cassette and the FD1793 land in the increments after the machine boots.
 */

import type { MachineHost, MachineServices } from '@/machines/machine.ts';
import type { LynxMachine } from '../lynx-machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import { LynxInputService } from './input.ts';
import { LynxRomService } from './roms.ts';
import { LynxMediaService } from './media.ts';
import { LynxFrameProbe } from './frame-probe.ts';

export interface LynxServices extends MachineServices {
  readonly media: LynxMediaService;
  readonly roms: LynxRomService;
  readonly tape: null;
  readonly disks: null;
  readonly snapshots: null;
  readonly input: LynxInputService;
  readonly probe: LynxFrameProbe;
}

export function createLynxServices(
  m: LynxMachine,
  host: () => MachineHost | null,
): LynxServices {
  return {
    media: new LynxMediaService(m),
    roms: new LynxRomService(m, host),
    tape: null,
    disks: null,
    snapshots: null,
    input: new LynxInputService(m),
    probe: new LynxFrameProbe(m),
    debug: new Z80DebugService(m),
  };
}
