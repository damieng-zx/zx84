/**
 * SAM MediaService — the machine's own file routing.
 *
 * The interesting case is `.dsk`. Everywhere else in zx84 that extension means
 * the CPC/+3 container; on the SAM it is usually a raw 819,200-byte MGT dump.
 * Routing therefore goes by CONTENT (see `parseSamMedia`), and the container
 * magic is tested before the size table so an 819,200-byte EDSK is not
 * silently misread as a raw dump. A DSK container is mounted whatever
 * formatted it — `parseSamMedia` explains why nothing inside can be trusted to
 * say.
 *
 * Tape images are the Spectrum-referenced pulse formats SimCoupe also reads
 * through libspectrum: TAP, TZX and CSW. Snapshots are not fitted.
 *
 * Everything arrives through `gunzipped()` first, because a SAM image is very
 * often a gzip stream wearing a `.dsk` name — that is how ZXDB ships its whole
 * SAM library, and SimCoupe reads any stream through zlib for the same reason.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { parseCSW } from '@/media/tape/csw.ts';
import type { SamMachine } from '../sam-machine.ts';
import { isSad, parseSamMedia, type SamDiskService } from './disks.ts';
import type { SamTapeService } from './tape.ts';

const DISK_EXT = /\.(mgt|img|dsk|sad|hfe|scp)$/i;
const TAPE_EXT = /\.(tap|tzx|csw)$/i;

function fail(message: string): MountResult { return { ok: false, message }; }

/**
 * Transparently expand a gzip stream.
 *
 * A SAM disk is routed by content, and a compressed one matches nothing: it is
 * not an HFE, not an SCP, not 819,200 bytes. So this runs before any sniffing,
 * on disks and tapes alike — the file keeps its `.dsk`/`.mgt` name either way,
 * so only the bytes change.
 */
async function gunzipped(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 2 || data[0] !== 0x1F || data[1] !== 0x8B) return data;
  const stream = new Blob([data as unknown as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class SamMediaService implements MediaService {
  constructor(
    private readonly m: SamMachine,
    private readonly disks: SamDiskService,
    private readonly tape: SamTapeService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.mgt', target: 'a' },
      { ext: '.img', target: 'a' },
      { ext: '.dsk', target: 'a' },
      { ext: '.hfe', target: '1' },
      { ext: '.scp', target: '1' },
      { ext: '.tap', target: 'tape' },
      { ext: '.tzx', target: 'tape' },
      { ext: '.csw', target: 'tape' },
    ];
  }

  async mount(
    rawData: Uint8Array,
    filename: string,
    target?: MediaTargetId,
  ): Promise<MountResult> {
    let data: Uint8Array;
    try {
      data = await gunzipped(rawData);
    } catch (e) {
      return fail(`Could not expand ${filename}: ${(e as Error).message}`);
    }

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

    const id = target === 'b' || target === '2' ? 'b' : 'a';
    this.m.stop();
    try {
      const image = parseSamMedia(data, filename);
      if (!image) {
        return fail(`Unrecognised disk image: ${filename}`);
      }
      this.disks.insert(id, image, filename);
      return {
        ok: true,
        target: id,
        message: `Drive ${id === 'b' ? 2 : 1}: loaded: ${filename}`,
      };
    } catch (e) {
      return fail(`Disk error: ${(e as Error).message}`);
    } finally {
      this.m.start();
    }
  }
}
