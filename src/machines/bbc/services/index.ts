import { M6502DebugService } from '@/debug/m6502/service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import type { BbcMachine } from '../bbc-machine.ts';
import { BbcFrameProbe } from './frame-probe.ts';
import { BbcInputService } from './input.ts';
import { BbcMediaService } from './media.ts';
import { BbcRomService } from './roms.ts';
import { BbcDiskService } from './disks.ts';

export interface BbcServices extends MachineServices {
  readonly media: BbcMediaService;
  readonly roms: BbcRomService;
  readonly tape: null;
  readonly disks: BbcDiskService;
  readonly snapshots: null;
  readonly input: BbcInputService;
  readonly probe: BbcFrameProbe;
}

export function createBbcServices(machine: BbcMachine): BbcServices {
  const roms = new BbcRomService(machine, () => machine.host);
  const disks = new BbcDiskService(machine);
  return {
    media: new BbcMediaService(machine, disks),
    roms,
    tape: null,
    disks,
    snapshots: null,
    input: new BbcInputService(machine),
    probe: new BbcFrameProbe(machine),
    debug: new M6502DebugService(machine),
  };
}
