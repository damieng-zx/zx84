/**
 * Assembles the Spectrum's service surface (§3.3 of docs/re-architecture.md).
 * Constructed once per machine; the shell/MCP reach machine internals only
 * through these.
 */

import type { MachineServices } from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { SpectrumInputService } from './input.ts';
import { SpectrumTapeService } from './tape.ts';
import { SpectrumDiskService } from './disks.ts';
import { SpectrumRomService } from './roms.ts';
import { SpectrumSnapshotService } from './snapshots.ts';
import { SpectrumMediaService } from './media.ts';

export interface SpectrumServices extends MachineServices {
  readonly media: SpectrumMediaService;
  readonly roms: SpectrumRomService;
  readonly tape: SpectrumTapeService;
  readonly disks: SpectrumDiskService;
  readonly snapshots: SpectrumSnapshotService;
  readonly input: SpectrumInputService;
}

export function createSpectrumServices(s: Spectrum): SpectrumServices {
  const host = () => s.host;
  const tape = new SpectrumTapeService(s);
  const disks = new SpectrumDiskService(s);
  const roms = new SpectrumRomService(s, host);
  const snapshots = new SpectrumSnapshotService(s, host);
  const media = new SpectrumMediaService(s, disks, tape, snapshots, roms);
  return { media, roms, tape, disks, snapshots, input: new SpectrumInputService(s) };
}
