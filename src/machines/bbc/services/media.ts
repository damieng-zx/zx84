import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { parseSsd, SSD_TRACK_BYTES } from '@/media/floppy/ssd.ts';
import type { BbcMachine } from '../bbc-machine.ts';
import type { BbcDiskService } from './disks.ts';
import type { AcornTapeService } from '@/machines/shared/acorn-tape-service.ts';

/** The drive a mount target names: 'a' / 'b' directly, or the shell's
 *  family-agnostic `unit:N` hint (unit 0 = drive 0, unit 1 = drive 1). */
function driveOf(target: MediaTargetId | undefined): 'a' | 'b' {
  if (target === 'b') return 'b';
  const unit = /^unit:(\d+)$/.exec(target ?? '');
  return unit && Number(unit[1]) === 1 ? 'b' : 'a';
}

/** BBC media routing: Acorn DFS raw disk images (.ssd/.dsd/.img) and UEF/CSW
 *  cassette images. A disc loaded into drive 0 is auto-booted with SHIFT+BREAK,
 *  as a user would; a tape is mounted and waits for the user's *TAPE/CHAIN. */
export class BbcMediaService implements MediaService {
  constructor(
    private readonly machine: BbcMachine,
    private readonly disks: BbcDiskService,
    private readonly tape: AcornTapeService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.ssd', target: 'a' },
      { ext: '.dsd', target: 'a' },
      { ext: '.img', target: 'a' },
      { ext: '.uef', target: 'tape' },
      { ext: '.csw', target: 'tape' },
      { ext: '.wav', target: 'tape' },
    ];
  }

  async mount(
    data: Uint8Array,
    filename: string,
    target?: MediaTargetId,
  ): Promise<MountResult> {
    if (/\.(?:ssd|dsd|img)$/i.test(filename)) {
      // .dsd is always two sides; a .img over a single-sided 80-track image
      // (204800 bytes) is taken as double-sided.
      const doubleSided = /\.dsd$/i.test(filename)
        || (/\.img$/i.test(filename) && data.length > SSD_TRACK_BYTES * 80);
      const id = driveOf(target);
      if (id === 'b' && this.machine.driveCount < 2) {
        return { ok: false, message: 'Drive 1 is not fitted (change the drive count in the Drives pane)' };
      }
      try {
        this.disks.insert(id, parseSsd(data, doubleSided), filename);
        if (id === 'a') this.machine.bootDisc();
        return {
          ok: true,
          target: id,
          message: id === 'a'
            ? `Drive 0 loaded: ${filename} (SHIFT+BREAK)`
            : `Drive 1 loaded: ${filename}`,
        };
      } catch (err) {
        return { ok: false, message: `Disk error: ${(err as Error).message}` };
      }
    }
    if (/\.(?:uef|csw|wav)$/i.test(filename)) {
      if (!(await this.tape.mountBytes(data, filename))) {
        return { ok: false, message: `Tape error: ${filename} is not a readable UEF, CSW or WAVE image` };
      }
      return {
        ok: true,
        target: 'tape',
        message: `Tape loaded: ${filename} — type *TAPE then CHAIN"" (or *RUN)`,
      };
    }
    return { ok: false, message: 'BBC accepts .ssd/.dsd/.img disk images and .uef/.csw/.wav tapes' };
  }
}
