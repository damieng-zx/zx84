/**
 * Assembles the Spectrum's service surface.
 * Constructed once per machine; the shell/MCP reach machine internals only
 * through these.
 */

import type { MachineServices } from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import { SpectrumInputService } from './input.ts';
import { spectrumTapeService } from './tape.ts';
import type { DeckTapeService } from '@/machines/shared/deck-tape-service.ts';
import { SpectrumDiskService } from './disks.ts';
import { SpectrumRomService } from './roms.ts';
import { SpectrumSnapshotService } from './snapshots.ts';
import { SpectrumMediaService } from './media.ts';
import { SpectrumFrameProbe } from './frame-probe.ts';
import { SpectrumInspection } from './inspect.ts';

export interface SpectrumServices extends MachineServices {
  readonly media: SpectrumMediaService;
  readonly roms: SpectrumRomService;
  readonly tape: DeckTapeService;
  readonly disks: SpectrumDiskService;
  readonly snapshots: SpectrumSnapshotService;
  readonly input: SpectrumInputService;
  readonly probe: SpectrumFrameProbe;
  readonly inspect: SpectrumInspection;
}

export function createSpectrumServices(s: Spectrum): SpectrumServices {
  const host = () => s.host;
  const tape = spectrumTapeService(s);
  const disks = new SpectrumDiskService(s);
  const roms = new SpectrumRomService(s, host);
  const snapshots = new SpectrumSnapshotService(s, host);
  const media = new SpectrumMediaService(s, disks, tape, snapshots, roms);
  return {
    media, roms, tape, disks, snapshots,
    input: new SpectrumInputService(s),
    probe: new SpectrumFrameProbe(s),
    inspect: new SpectrumInspection(s),
    debug: new Z80DebugService(s),
  };
}
