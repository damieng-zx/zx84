/**
 * SAM MediaService — the machine's own file routing.
 *
 * The interesting case is `.dsk`. Everywhere else in zx84 that extension means
 * the CPC/+3 container; on the SAM it is almost always a raw 819,200-byte MGT
 * dump. Routing therefore goes by CONTENT (see `parseSamMedia`), and the
 * container magic is tested before the size table so an 819,200-byte EDSK is
 * not silently misread as a raw dump.
 *
 * Tapes and snapshots are not fitted yet and land in a later phase.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { SamMachine } from '../sam-machine.ts';
import { isDskContainer, isSad, parseSamMedia, type SamDiskService } from './disks.ts';

const DISK_EXT = /\.(mgt|img|dsk|sad|hfe|scp)$/i;

function fail(message: string): MountResult { return { ok: false, message }; }

export class SamMediaService implements MediaService {
  constructor(
    private readonly m: SamMachine,
    private readonly disks: SamDiskService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.mgt', target: '1' },
      { ext: '.img', target: '1' },
      { ext: '.dsk', target: '1' },
      { ext: '.hfe', target: '1' },
      { ext: '.scp', target: '1' },
    ];
  }

  async mount(
    data: Uint8Array,
    filename: string,
    target?: MediaTargetId,
  ): Promise<MountResult> {
    if (!DISK_EXT.test(filename)) {
      return fail('SAM accepts .mgt, .img, .dsk, .hfe and .scp disk images');
    }

    // Refused rather than guessed at: the SAD container's sector ordering
    // (cylinder-major vs head-major) could not be confirmed, and a wrong guess
    // reads the whole disk scrambled instead of failing honestly.
    if (isSad(data)) {
      return fail('SAD (.sad) images are not supported yet — convert to .mgt');
    }
    if (isDskContainer(data)) {
      return fail('That is an Amstrad CPC/+3 disk image, not a SAM one');
    }

    const id = target === '2' ? '2' : '1';
    this.m.stop();
    try {
      const image = parseSamMedia(data, filename);
      if (!image) {
        return fail(`Unrecognised disk image: ${filename}`);
      }
      this.disks.insert(id, image, filename);
      return { ok: true, target: id, message: `Drive ${id}: loaded: ${filename}` };
    } catch (e) {
      return fail(`Disk error: ${(e as Error).message}`);
    } finally {
      this.m.start();
    }
  }
}
