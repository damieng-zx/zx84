import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { parseAcornDisc } from '@/media/floppy/acorn-disc.ts';
import { ACORN_TAPE_EXTENSIONS, type AcornTapeService } from '@/machines/shared/acorn-tape-service.ts';
import type { AcornSystemMachine } from '../machine.ts';
import type { AcornSystemDiskService } from './disks.ts';

/** The drive a mount target names: 'a'/'b', or the shell's `unit:N` hint. */
function driveOf(target: MediaTargetId | undefined): 'a' | 'b' {
  if (target === 'b') return 'b';
  const unit = /^unit:(\d+)$/.exec(target ?? '');
  return unit && Number(unit[1]) === 1 ? 'b' : 'a';
}

/**
 * Acorn System media routing.
 *
 * A System 3 takes single-density Acorn discs (ten 256-byte FM sectors per
 * track, 40 or 80 track, one or two sides) in either drive; those are the raw
 * `.ssd`/`.dsd` dumps plus HFE/SCP bitstream images. The cassette works on both
 * models, and ROM images go through the ROM pane's own picker.
 *
 * There is no boot key: the DOS is resident in ROM, so a disc is just inserted
 * and the prompt is already there.
 */
export class AcornSystemMediaService implements MediaService {
  constructor(
    private readonly machine: AcornSystemMachine,
    private readonly tape: AcornTapeService,
    private readonly disks: AcornSystemDiskService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    const types: MediaTypeDescriptor[] = [];
    if (this.machine.disk) {
      types.push(
        { ext: '.ssd', target: 'a' },
        { ext: '.dsd', target: 'a' },
        { ext: '.img', target: 'a' },
        { ext: '.hfe', target: 'a' },
        { ext: '.scp', target: 'a' },
      );
    }
    return [...types, ...ACORN_TAPE_EXTENSIONS.map(ext => ({ ext, target: 'tape' }))];
  }

  async mount(
    data: Uint8Array,
    filename: string,
    target?: MediaTargetId,
  ): Promise<MountResult> {
    if (/\.(?:ssd|dsd|img|hfe|scp)$/i.test(filename)) {
      if (!this.machine.disk) {
        return { ok: false, message: 'This model has no disc controller (a System 3 does)' };
      }
      try {
        const { image } = parseAcornDisc(data, filename, 'dfs');
        // The 8271 reads single-density discs only; a double-density image
        // would fail at every sector.
        if (!image.tracks.some(row => row.some(t => t && t.sectors.length > 0 && t.encoding !== 'mfm'))) {
          return { ok: false, message: `${filename} is a double-density disc; the 8271 reads single-density (FM) discs` };
        }
        const id = driveOf(target);
        this.disks.insert(id, image, filename);
        return { ok: true, target: id, message: `Drive ${id === 'a' ? 0 : 1} loaded: ${filename}` };
      } catch (err) {
        return { ok: false, message: `Disk error: ${(err as Error).message}` };
      }
    }
    if (/\.(uef|csw|wav)$/i.test(filename)) {
      if (!await this.tape.mountBytes(data, filename)) {
        return { ok: false, message: `Tape error: ${filename} is not a readable UEF, CSW or WAVE image` };
      }
      return { ok: true, target: 'tape', message: `Tape loaded: ${filename}` };
    }
    return {
      ok: false,
      message: `${this.machine.descriptor.model} loads .ssd/.dsd/.img/.hfe/.scp discs and .uef/.csw/.wav tapes`,
    };
  }
}
