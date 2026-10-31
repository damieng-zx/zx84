/**
 * PCW MediaService — file routing for a disc-only machine.
 *
 * PCW software is distributed as .dsk and .td0 (and the flux/bitstream formats
 * this codebase also reads) — the CP/M boot discs in particular survive mostly
 * as Teledisk images. A PCW has nothing else to load into: no cassette,
 * no cartridge and no ROM. Everything arrives through a drive, and inserting
 * into drive A on an unbooted machine starts the boot — see
 * `PcwMachine.loadDisk`. The one exception is zx84's own `.pcwstate`
 * snapshot, which restores the whole machine and its discs.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { parseFloppyImage } from '@/media/floppy/hfe.ts';
import type { PcwMachine } from '../pcw-machine.ts';
import type { PcwDiskService } from './disks.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';

function fail(message: string): MountResult { return { ok: false, message }; }

export class PcwMediaService implements MediaService {
  constructor(
    private readonly m: PcwMachine,
    private readonly disks: PcwDiskService,
    private readonly snapshots: NativeSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    const out: MediaTypeDescriptor[] = [
      { ext: '.dsk', target: 'a' },
      { ext: '.td0', target: 'a' },
      { ext: '.hfe', target: 'a' },
      { ext: '.scp', target: 'a' },
      { ext: '.pcwstate', target: 'snapshot' },
    ];
    return out;
  }

  private unitOf(target: MediaTargetId | undefined): number {
    if (target === 'b') return 1;
    if (target && target.startsWith('unit:')) return Number(target.slice(5));
    return 0;
  }

  async mount(data: Uint8Array, filename: string, target?: MediaTargetId): Promise<MountResult> {
    if (/\.pcwstate$/i.test(filename)) {
      const r = await this.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      // A saved state carries its own discs: the panes re-read the drives.
      return r.ok ? { ok: true, target: 'snapshot', mediaChanged: true, message: r.message } : fail(r.message);
    }
    if (!/\.(dsk|td0|hfe|scp)$/i.test(filename)) {
      return fail('The PCW accepts .dsk, .td0, .hfe, .scp and .zip disc images and .pcwstate snapshots');
    }
    const m = this.m;
    const unit = this.unitOf(target);
    if (unit >= m.driveCount) return fail('That drive is not fitted');
    const id = unit === 0 ? 'a' : 'b';
    m.stop();
    try {
      const image = parseFloppyImage(data);
      this.disks.insert(id, image, filename);
      return { ok: true, target: id, message: `Drive ${id.toUpperCase()}: loaded: ${filename}` };
    } catch (err) {
      return fail(`Disc error: ${(err as Error).message}`);
    } finally {
      m.start();
    }
  }
}
