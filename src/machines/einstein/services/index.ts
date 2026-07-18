/**
 * Assembles the Einstein's service surface (§3.3 of docs/re-architecture.md).
 * The Einstein has no cassette (its deck is inert) and no snapshot format, so
 * `tape` and `snapshots` are null.
 */

import type { MachineServices } from '@/machines/machine.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import { EinsteinInputService } from './input.ts';
import { EinsteinDiskService } from './disks.ts';
import { EinsteinRomService } from './roms.ts';
import { EinsteinMediaService } from './media.ts';

export interface EinsteinServices extends MachineServices {
  readonly media: EinsteinMediaService;
  readonly roms: EinsteinRomService;
  readonly tape: null;
  readonly disks: EinsteinDiskService;
  readonly snapshots: null;
  readonly input: EinsteinInputService;
}

export function createEinsteinServices(e: EinsteinMachine): EinsteinServices {
  const host = () => e.host;
  const disks = new EinsteinDiskService(e);
  const roms = new EinsteinRomService(host);
  const media = new EinsteinMediaService(e, disks);
  return { media, roms, tape: null, disks, snapshots: null, input: new EinsteinInputService(e) };
}
