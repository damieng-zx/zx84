/**
 * The Enterprise's service surface. No tape (the collection is files and
 * disks) and no snapshots; the disk service is inert while the EXDOS card is
 * removed.
 */

import type { MachineHost, MachineServices } from '@/machines/machine.ts';
import type { EnterpriseMachine } from '../enterprise-machine.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import { EnterpriseInputService } from './input.ts';
import { EnterpriseRomService } from './roms.ts';
import { EnterpriseMediaService } from './media.ts';
import { EnterpriseFrameProbe } from './frame-probe.ts';
import { EnterpriseDiskService } from './disks.ts';

export interface EnterpriseServices extends MachineServices {
  readonly media: EnterpriseMediaService;
  readonly roms: EnterpriseRomService;
  readonly tape: null;
  readonly disks: EnterpriseDiskService;
  readonly snapshots: null;
  readonly input: EnterpriseInputService;
  readonly probe: EnterpriseFrameProbe;
}

export function createEnterpriseServices(
  m: EnterpriseMachine,
  host: () => MachineHost | null,
): EnterpriseServices {
  const disks = new EnterpriseDiskService(m);
  return {
    media: new EnterpriseMediaService(m, disks, host),
    roms: new EnterpriseRomService(m, host),
    tape: null,
    disks,
    snapshots: null,
    input: new EnterpriseInputService(m),
    probe: new EnterpriseFrameProbe(m),
    debug: new Z80DebugService(m),
  };
}
