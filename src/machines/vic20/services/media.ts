/**
 * Vic20MediaService — what a dropped file means on the VIC-20. In this first
 * phase only the machine's own snapshots load; programs, tapes, disks and
 * cartridges follow in the later phases of the plan.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { VIC20_STATE } from '../snapshots/vic20-state.ts';

export class Vic20MediaService implements MediaService {
  constructor(private readonly snapshots: NativeSnapshotService) {}

  accepts(): MediaTypeDescriptor[] {
    return [{ ext: VIC20_STATE.ext, target: 'snapshot' }];
  }

  async mount(data: Uint8Array, filename: string, _target?: MediaTargetId): Promise<MountResult> {
    const name = filename.replace(/^.*[\\/]/, '');
    if (name.toLowerCase().endsWith(VIC20_STATE.ext)) {
      const r = await this.snapshots.apply(data, name);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      return r.ok
        ? { ok: true, target: 'snapshot', message: r.message }
        : { ok: false, message: r.message };
    }
    return { ok: false, message: 'The VIC-20 loads .vic20state snapshots so far' };
  }
}
