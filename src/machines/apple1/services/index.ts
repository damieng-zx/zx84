import { M6502DebugService } from '@/debug/m6502/service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import type { Apple1Machine } from '../apple1-machine.ts';
import { Apple1FrameProbe } from './frame-probe.ts';
import { Apple1InputService } from './input.ts';
import { Apple1MediaService } from './media.ts';
import { Apple1RomService } from './roms.ts';

export interface Apple1Services extends MachineServices {
  readonly media: Apple1MediaService;
  readonly roms: Apple1RomService;
  readonly tape: null;
  readonly disks: null;
  readonly snapshots: null;
  readonly input: Apple1InputService;
  readonly probe: Apple1FrameProbe;
}

export function createApple1Services(machine: Apple1Machine): Apple1Services {
  return {
    media: new Apple1MediaService(),
    roms: new Apple1RomService(machine, () => machine.host),
    tape: null,
    disks: null,
    snapshots: null,
    input: new Apple1InputService(machine),
    probe: new Apple1FrameProbe(machine),
    debug: new M6502DebugService(machine),
  };
}
