/**
 * Einstein MediaService — the machine's own file routing, ported verbatim from
 * the shell's Einstein loadFile branch: only disk images (.dsk/.hfe/.scp), read
 * by the WD1772. ZIP unwrapping stays a shell concern.
 *
 * The service mutates the machine only. Signals, persistence and the Xtal-DOS
 * phantom reconciliation stay shell reflection, keyed off MountResult.target.
 */

import type { MediaService, MediaTypeDescriptor, MediaTargetId, MountResult } from '@/machines/machine.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import { parseFloppyImage } from '@/media/floppy/hfe.ts';
import type { EinsteinDiskService } from './disks.ts';

function fail(message: string): MountResult { return { ok: false, message }; }

export class EinsteinMediaService implements MediaService {
  constructor(
    private readonly e: EinsteinMachine,
    private readonly disks: EinsteinDiskService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    if (!this.e.config.hasFDC) return [];
    return [
      { ext: '.dsk', target: 'a' },
      { ext: '.hfe', target: 'a' },
      { ext: '.scp', target: 'a' },
    ];
  }

  private static unitOf(target: MediaTargetId | undefined): number {
    if (target === 'b') return 1;
    if (target && target.startsWith('unit:')) return Number(target.slice(5));
    return 0;
  }

  async mount(data: Uint8Array, filename: string, target?: MediaTargetId): Promise<MountResult> {
    if (!/\.(dsk|hfe|scp)$/i.test(filename)) {
      return fail('Einstein accepts .dsk, .hfe, .scp and .zip disk images');
    }
    const e = this.e;
    const unit = EinsteinMediaService.unitOf(target);
    e.stop();
    try {
      const image = parseFloppyImage(data);
      this.disks.insert(unit === 0 ? 'a' : 'b', image, filename);
      return { ok: true, target: unit === 0 ? 'a' : 'b', message: `Drive ${unit}: loaded: ${filename}` };
    } catch (err) {
      return fail(`DSK error: ${(err as Error).message}`);
    } finally {
      e.start();
    }
  }
}
