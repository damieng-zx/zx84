/**
 * Assembles the Einstein's service surface.
 * The Einstein has no cassette (its deck is inert), so `tape` is null.
 * Snapshots are zx84's own `.einstate`.
 */

import type { MachineServices } from '@/machines/machine.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import { EinsteinInputService } from './input.ts';
import { EinsteinDiskService } from './disks.ts';
import { EinsteinRomService } from './roms.ts';
import { EinsteinMediaService } from './media.ts';
import { EinsteinFrameProbe } from './frame-probe.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { EINSTEIN_STATE } from '../snapshots/einstein-state.ts';

export interface EinsteinServices extends MachineServices {
  readonly media: EinsteinMediaService;
  readonly roms: EinsteinRomService;
  readonly tape: null;
  readonly disks: EinsteinDiskService;
  readonly snapshots: NativeSnapshotService;
  readonly input: EinsteinInputService;
  readonly probe: EinsteinFrameProbe;
}

export function createEinsteinServices(e: EinsteinMachine): EinsteinServices {
  const host = () => e.host;
  const disks = new EinsteinDiskService(e);
  const roms = new EinsteinRomService(e, host);
  const snapshots = new NativeSnapshotService(EINSTEIN_STATE, e, host);
  const media = new EinsteinMediaService(e, disks, snapshots);
  return {
    media, roms, tape: null, disks, snapshots,
    input: new EinsteinInputService(e),
    probe: new EinsteinFrameProbe(e),
    debug: new Z80DebugService(e),
  };
}
