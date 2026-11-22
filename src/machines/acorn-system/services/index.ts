import { M6502DebugService } from '@/debug/m6502/service.ts';
import { AcornTapeService } from '@/machines/shared/acorn-tape-service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import type { AcornSystemMachine } from '../machine.ts';
import { AcornSystemFrameProbe } from './frame-probe.ts';
import { AcornSystemInputService } from './input.ts';
import { AcornSystemMediaService } from './media.ts';
import { AcornSystemRomService } from './roms.ts';

export interface AcornSystemServices extends MachineServices {
  readonly media: AcornSystemMediaService;
  readonly roms: AcornSystemRomService;
  /** The CUTS cassette interface on the CPU card. */
  readonly tape: AcornTapeService;
  readonly disks: null;
  readonly snapshots: null;
  readonly input: AcornSystemInputService;
  readonly probe: AcornSystemFrameProbe;
}

export function createAcornSystemServices(machine: AcornSystemMachine): AcornSystemServices {
  const tape = new AcornTapeService(machine.cassette, 'acorn-system-tape.uef');
  return {
    media: new AcornSystemMediaService(machine, tape),
    roms: new AcornSystemRomService(machine, () => machine.host),
    tape,
    disks: null,
    snapshots: null,
    input: new AcornSystemInputService(machine),
    probe: new AcornSystemFrameProbe(machine),
    debug: new M6502DebugService(machine),
  };
}
