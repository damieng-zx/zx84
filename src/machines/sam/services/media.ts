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
 * Everything arrives through `unwrapped()` first, because a SAM image very
 * often is not the thing its name claims. `.dsk` files in the wild turn out to
 * be gzip streams (ZXDB's whole SAM library) or ZIP archives with the real
 * image inside, sometimes both. SimCoupe reads any stream through zlib and
 * opens archives the same way, so a file it loads must load here too.
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
import { unzip } from '@/media/zip.ts';

const DISK_EXT = /\.(mgt|img|dsk|sad|hfe|scp)$/i;
const TAPE_EXT = /\.(tap|tzx|csw)$/i;

function fail(message: string): MountResult { return { ok: false, message }; }

/** ZIP local-file-header signature ("PK", 0x03, 0x04). */
function isZip(d: Uint8Array): boolean {
  return d.length > 4 && d[0] === 0x50 && d[1] === 0x4B && d[2] === 0x03 && d[3] === 0x04;
}

/** gzip magic. */
function isGzip(d: Uint8Array): boolean {
  return d.length > 2 && d[0] === 0x1F && d[1] === 0x8B;
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Peel the wrappers off a SAM image, and report the name of what was inside.
 *
 * A SAM disk is routed by content, and a wrapped one matches nothing: it is
 * not an HFE, not an SCP, not 819,200 bytes. Both wrappers are common enough
 * that neither can be treated as a curiosity:
 *
 *   - gzip wearing a `.dsk` name — every disk in ZXDB's SAM library;
 *   - a ZIP archive wearing a `.dsk` name, holding the real image. The shell
 *     unwraps archives by EXTENSION, so one called `.dsk` sails straight past
 *     it and arrives here still packed.
 *
 * They nest, so the ZIP is opened first and its contents checked for gzip.
 * The inner name is returned because it, not the outer one, says what the
 * bytes are — an archive may perfectly well be `game.dsk` holding `game.mgt`.
 */
async function unwrapped(
  data: Uint8Array,
  filename: string,
): Promise<{ data: Uint8Array; filename: string }> {
  let out = data;
  let name = filename;
  if (isZip(out)) {
    const entries = await unzip(out);
    if (entries.length === 0) throw new Error('no loadable file inside');
    // Several entries is unusual here (the shell's picker handles the archives
    // that announce themselves); prefer one this machine can actually mount.
    const pick = entries.find(e => DISK_EXT.test(e.name) || TAPE_EXT.test(e.name)) ?? entries[0];
    out = pick.data;
    name = pick.name;
  }
  if (isGzip(out)) out = await gunzip(out);
  return { data: out, filename: name };
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
      { ext: '.hfe', target: 'a' },
      { ext: '.scp', target: 'a' },
      { ext: '.tap', target: 'tape' },
      { ext: '.tzx', target: 'tape' },
      { ext: '.csw', target: 'tape' },
    ];
  }

  async mount(
    rawData: Uint8Array,
    rawName: string,
    target?: MediaTargetId,
  ): Promise<MountResult> {
    let data: Uint8Array;
    let filename: string;
    try {
      ({ data, filename } = await unwrapped(rawData, rawName));
    } catch (e) {
      return fail(`Could not expand ${rawName}: ${(e as Error).message}`);
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
