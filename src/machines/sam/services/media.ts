/**
 * SAM MediaService — the machine's own file routing.
 *
 * The interesting case is `.dsk`. Everywhere else in zx84 that extension means
 * the CPC/+3 container; on the SAM it is almost always a raw 819,200-byte MGT
 * dump. Routing therefore goes by CONTENT (see `parseSamMedia`), and the
 * container magic is tested before the size table so an 819,200-byte EDSK is
 * not silently misread as a raw dump.
 *
 * Tape images are the Spectrum-referenced pulse formats SimCoupe also reads
 * through libspectrum: TAP, TZX and CSW. Snapshots are not fitted.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { parseCSW } from '@/media/tape/csw.ts';
import type { SamMachine } from '../sam-machine.ts';
import { isDskContainer, isSad, parseSamMedia, type SamDiskService } from './disks.ts';
import type { SamTapeService } from './tape.ts';

const DISK_EXT = /\.(mgt|img|dsk|sad|hfe|scp)$/i;
const TAPE_EXT = /\.(tap|tzx|csw)$/i;

function fail(message: string): MountResult { return { ok: false, message }; }

export class SamMediaService implements MediaService {
  constructor(
    private readonly m: SamMachine,
    private readonly disks: SamDiskService,
    private readonly tape: SamTapeService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.mgt', target: '1' },
      { ext: '.img', target: '1' },
      { ext: '.dsk', target: '1' },
      { ext: '.hfe', target: '1' },
      { ext: '.scp', target: '1' },
      { ext: '.tap', target: 'tape' },
      { ext: '.tzx', target: 'tape' },
      { ext: '.csw', target: 'tape' },
    ];
  }

  async mount(
    data: Uint8Array,
    filename: string,
    target?: MediaTargetId,
  ): Promise<MountResult> {
    // Cassette images: the same pulse-level formats the Spectrum uses, with
    // their 3.5 MHz-referenced pulse lengths scaled to the SAM's 6 MHz clock.
    if (TAPE_EXT.test(filename)) {
      this.m.stop();
      let blocks: TapeBlock[];
      try {
        const ext = filename.toLowerCase().split('.').pop();
        blocks = ext === 'tzx' ? parseTZX(data)
          : ext === 'csw' ? await parseCSW(data)
          : this.m.tape.parseTAP(data);
      } catch (e) {
        return fail(`Tape error: ${(e as Error).message}`);
      } finally {
        this.m.start();
      }
      if (blocks.length === 0) return fail(`No tape blocks in ${filename}`);
      this.tape.mountBlocks(blocks, filename);
      return { ok: true, target: 'tape', message: `Tape loaded: ${filename}` };
    }

    if (!DISK_EXT.test(filename)) {
      return fail('SAM accepts .mgt, .img, .dsk, .hfe and .scp disks, '
        + 'and .tap, .tzx and .csw tapes');
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
