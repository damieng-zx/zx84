/**
 * The Lynx's service surface. Disks and snapshots are still null: the FD1793
 * lands with the .ldf sector-dump parser.
 */

import type { MachineHost, MachineServices } from '@/machines/machine.ts';
import type { LynxMachine } from '../lynx-machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import { LynxInputService } from './input.ts';
import { LynxRomService } from './roms.ts';
import { LynxMediaService } from './media.ts';
import { LynxFrameProbe } from './frame-probe.ts';
import { LynxTapeService } from './tape.ts';

export interface LynxServices extends MachineServices {
  readonly media: LynxMediaService;
  readonly roms: LynxRomService;
  readonly tape: LynxTapeService;
  readonly disks: null;
  readonly snapshots: null;
  readonly input: LynxInputService;
  readonly probe: LynxFrameProbe;
}

export function createLynxServices(
  m: LynxMachine,
  host: () => MachineHost | null,
): LynxServices {
  const tape = new LynxTapeService(m);
  return {
    media: new LynxMediaService(m, tape),
    roms: new LynxRomService(m, host),
    tape,
    disks: null,
    snapshots: null,
    input: new LynxInputService(m),
    probe: new LynxFrameProbe(m),
    debug: new Z80DebugService(m),
  };
}
