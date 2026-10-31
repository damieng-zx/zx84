import type { MachineServices } from '@/machines/machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import type { Zx8xMachine } from '../zx8x-machine.ts';
import { Zx8xRomService } from './roms.ts';
import { Zx8xInputService } from './input.ts';
import { Zx8xMediaService } from './media.ts';
import { Zx8xFrameProbe } from './frame-probe.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { ZX8X_STATE } from '../snapshots/zx8x-state.ts';
import { Zx8xTapeService } from './tape.ts';

export interface Zx8xServices extends MachineServices {
  readonly media: Zx8xMediaService;
  readonly roms: Zx8xRomService;
  readonly tape: Zx8xTapeService;
  readonly disks: null;
  readonly snapshots: NativeSnapshotService;
  readonly input: Zx8xInputService;
  readonly probe: Zx8xFrameProbe;
}

export function createZx8xServices(machine: Zx8xMachine): Zx8xServices {
  const snapshots = new NativeSnapshotService(ZX8X_STATE, machine, () => machine.host);
  return {
    media: new Zx8xMediaService(machine, snapshots),
    roms: new Zx8xRomService(machine, () => machine.host),
    tape: new Zx8xTapeService(machine),
    disks: null,
    snapshots,
    input: new Zx8xInputService(machine),
    probe: new Zx8xFrameProbe(machine),
    debug: new Z80DebugService(machine),
  };
}
