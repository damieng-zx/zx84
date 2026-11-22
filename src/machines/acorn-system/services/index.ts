import { M6502DebugService } from '@/debug/m6502/service.ts';
import { AcornTapeService } from '@/machines/shared/acorn-tape-service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import type { AcornSystemMachine } from '../machine.ts';
import { AcornSystemDiskService } from './disks.ts';
import { AcornSystemFrameProbe } from './frame-probe.ts';
import { AcornSystemInputService } from './input.ts';
import { AcornSystemMediaService } from './media.ts';
import { AcornSystemRomService } from './roms.ts';

export interface AcornSystemServices extends MachineServices {
  readonly media: AcornSystemMediaService;
  readonly roms: AcornSystemRomService;
  /** The CUTS cassette interface on the CPU card. */
  readonly tape: AcornTapeService;
  /** The 8271 card's drives, or null on a System 2 (the card is not fitted). */
  readonly disks: AcornSystemDiskService | null;
  readonly snapshots: null;
  readonly input: AcornSystemInputService;
  readonly probe: AcornSystemFrameProbe;
}

export function createAcornSystemServices(machine: AcornSystemMachine): AcornSystemServices {
  const tape = new AcornTapeService(machine.cassette, 'acorn-system-tape.uef');
  // One instance backs both the MediaService (which inserts a mounted disc)
  // and the DiskService the Drive pane binds to; the latter is absent when the
  // controller card is not fitted, which is how the pane knows to hide.
  const disks = new AcornSystemDiskService(machine);
  return {
    media: new AcornSystemMediaService(machine, tape, disks),
    roms: new AcornSystemRomService(machine, () => machine.host),
    tape,
    get disks() { return machine.diskFitted ? disks : null; },
    snapshots: null,
    input: new AcornSystemInputService(machine),
    probe: new AcornSystemFrameProbe(machine),
    debug: new M6502DebugService(machine),
  };
}
