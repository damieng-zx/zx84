/**
 * Einstein MediaService — the machine's own file routing, ported verbatim from
 * the shell's Einstein loadFile branch: disk images (.dsk/.hfe/.scp/.td0), read
 * by the WD1772, and `.einstate` snapshots. ZIP unwrapping stays a shell concern.
 *
 * The service mutates the machine only. Signals, persistence and the Xtal-DOS
 * phantom reconciliation stay shell reflection, keyed off MountResult.target.
 */

import type { MediaService, MediaTypeDescriptor, MediaTargetId, MountResult } from '@/machines/machine.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import { parseFloppyImage } from '@/media/floppy/hfe.ts';
import type { EinsteinDiskService } from './disks.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';

function fail(message: string): MountResult { return { ok: false, message }; }

export class EinsteinMediaService implements MediaService {
  constructor(
    private readonly e: EinsteinMachine,
    private readonly disks: EinsteinDiskService,
    private readonly snapshots: NativeSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    const snapshot: MediaTypeDescriptor = { ext: '.einstate', target: 'snapshot' };
    if (!this.e.config.hasFDC) return [snapshot];
    return [
      { ext: '.dsk', target: 'a' },
      { ext: '.hfe', target: 'a' },
      { ext: '.scp', target: 'a' },
      { ext: '.td0', target: 'a' },
      snapshot,
    ];
  }

  private static unitOf(target: MediaTargetId | undefined): number {
    if (target === 'b') return 1;
    if (target && target.startsWith('unit:')) return Number(target.slice(5));
    return 0;
  }

  async mount(data: Uint8Array, filename: string, target?: MediaTargetId): Promise<MountResult> {
    if (/\.einstate$/i.test(filename)) {
      const r = await this.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      // A saved state carries its own drives: the panes re-read them.
      return r.ok ? { ok: true, target: 'snapshot', mediaChanged: true, message: r.message } : fail(r.message);
    }
    if (!/\.(dsk|hfe|scp|td0)$/i.test(filename)) {
      return fail('Einstein accepts .dsk, .hfe, .scp, .td0 and .zip disk images and .einstate snapshots');
    }
    const unit = EinsteinMediaService.unitOf(target);
    if (!Number.isInteger(unit) || unit < 0 || unit >= this.e.driveCount) return fail('that drive is not fitted');
    try {
      const image = parseFloppyImage(data);
      this.disks.insert(unit === 0 ? 'a' : 'b', image, filename);
      return { ok: true, target: unit === 0 ? 'a' : 'b', message: `Drive ${unit}: loaded: ${filename}` };
    } catch (err) {
      return fail(`DSK error: ${(err as Error).message}`);
    }
  }
}
