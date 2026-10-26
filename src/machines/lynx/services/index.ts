/**
 * The Lynx's service surface. Snapshots are zx84's own `.lynxstate`; the
 * FD1793 disk service is present on every model but inert on the 48K
 * (`hasDisk` false).
 */

import type { MachineHost, MachineServices } from '@/machines/machine.ts';
import type { LynxMachine } from '../lynx-machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import { LynxInputService } from './input.ts';
import { LynxRomService } from './roms.ts';
import { LynxMediaService } from './media.ts';
import { LynxFrameProbe } from './frame-probe.ts';
import { LynxTapeService } from './tape.ts';
import { LynxDiskService } from './disks.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { LYNX_STATE } from '../snapshots/lynx-state.ts';

export interface LynxServices extends MachineServices {
  readonly media: LynxMediaService;
  readonly roms: LynxRomService;
  readonly tape: LynxTapeService;
  readonly disks: LynxDiskService;
  readonly snapshots: NativeSnapshotService;
  readonly input: LynxInputService;
  readonly probe: LynxFrameProbe;
}

export function createLynxServices(
  m: LynxMachine,
  host: () => MachineHost | null,
): LynxServices {
  const tape = new LynxTapeService(m);
  const disks = new LynxDiskService(m);
  const snapshots = new NativeSnapshotService(LYNX_STATE, m, host);
  return {
    media: new LynxMediaService(m, disks, tape, snapshots),
    roms: new LynxRomService(m, host),
    tape,
    disks,
    snapshots,
    input: new LynxInputService(m),
    probe: new LynxFrameProbe(m),
    debug: new Z80DebugService(m),
  };
}
