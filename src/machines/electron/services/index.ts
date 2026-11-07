import { M6502DebugService } from '@/debug/m6502/service.ts';
import type { MachineServices } from '@/machines/machine.ts';
import { AcornTapeService } from '@/machines/shared/acorn-tape-service.ts';
import type { ElectronMachine } from '../electron-machine.ts';
import { ElectronFrameProbe } from './frame-probe.ts';
import { ElectronInputService } from './input.ts';
import { ElectronMediaService } from './media.ts';
import { ElectronRomService } from './roms.ts';
import { ElectronDiskService } from './disks.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { ELECTRON_STATE_SPEC } from '../snapshots/electron-state.ts';

export interface ElectronServices extends MachineServices {
  readonly media: ElectronMediaService;
  readonly roms: ElectronRomService;
  readonly tape: AcornTapeService;
  readonly disks: ElectronDiskService;
  readonly snapshots: NativeSnapshotService;
  readonly input: ElectronInputService;
  readonly probe: ElectronFrameProbe;
}

export function createElectronServices(machine: ElectronMachine): ElectronServices {
  const tape = new AcornTapeService(machine.cassette, 'electron-tape.uef');
  const disks = new ElectronDiskService(machine);
  const snapshots = new NativeSnapshotService(ELECTRON_STATE_SPEC, machine, () => machine.host);
  return {
    media: new ElectronMediaService(machine, disks, tape, snapshots),
    roms: new ElectronRomService(machine, () => machine.host),
    tape,
    disks,
    snapshots,
    input: new ElectronInputService(machine),
    probe: new ElectronFrameProbe(machine),
    debug: new M6502DebugService(machine),
  };
}
