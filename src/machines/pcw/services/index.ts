/**
 * Assembles the PCW's service surface — the only way the shell, UI and MCP
 * server reach machine internals.
 *
 * A service returning `null` means "this machine hasn't got one" and the
 * generic panes hide themselves accordingly. The PCW has no cassette, so
 * `tape` is null; snapshots are zx84's own `.pcwstate`.
 */

import type { MachineServices } from '@/machines/machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import type { PcwMachine } from '../pcw-machine.ts';
import { PcwDiskService } from './disks.ts';
import { PcwFrameProbe } from './frame-probe.ts';
import { PcwInputService } from './input.ts';
import { PcwMediaService } from './media.ts';
import { PcwRomService } from './roms.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { PCW_STATE } from '../snapshots/pcw-state.ts';

export interface PcwServices extends MachineServices {
  readonly media: PcwMediaService;
  readonly roms: PcwRomService;
  readonly input: PcwInputService;
  readonly probe: PcwFrameProbe;
  readonly disks: PcwDiskService;
  readonly snapshots: NativeSnapshotService;
}

export function createPcwServices(m: PcwMachine): PcwServices {
  const disks = new PcwDiskService(m);
  const snapshots = new NativeSnapshotService(PCW_STATE, m, () => m.host);
  return {
    media: new PcwMediaService(m, disks, snapshots),
    roms: new PcwRomService(m),
    disks,
    tape: null,
    snapshots,
    input: new PcwInputService(m),
    probe: new PcwFrameProbe(m),
    debug: new Z80DebugService(m),
  };
}
