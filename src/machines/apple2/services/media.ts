import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { Apple2Machine } from '../apple2-machine.ts';
import type { Apple2DiskService } from './disks.ts';
import type { Apple2TapeService } from './tape.ts';

/** Apple II media routing: 5.25" sector images (`.dsk`/`.do`/`.po`) into the
 *  Disk II drives, and `.wav` cassette recordings onto the tape deck. A disk
 *  mounted in drive 1 boots, as a reset does. */
export class Apple2MediaService implements MediaService {
  constructor(
    private readonly machine: Apple2Machine,
    private readonly disks: Apple2DiskService,
    private readonly tape: Apple2TapeService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.dsk', target: 'a' },
      { ext: '.do', target: 'a' },
      { ext: '.po', target: 'a' },
      { ext: '.wav', target: 'tape' },
    ];
  }

  /** The drive a mount target names: 'a' / 'b' directly, or the shell's
   *  family-agnostic `unit:N` hint (unit 0 = drive 1, unit 1 = drive 2). */
  private static driveOf(target: MediaTargetId | undefined): 'a' | 'b' {
    if (target === 'b') return 'b';
    const unit = /^unit:(\d+)$/.exec(target ?? '');
    return unit && Number(unit[1]) === 1 ? 'b' : 'a';
  }

  async mount(
    data: Uint8Array,
    filename: string,
    target?: MediaTargetId,
  ): Promise<MountResult> {
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    if (ext === 'dsk' || ext === 'do' || ext === 'po') {
      const id = Apple2MediaService.driveOf(target);
      try {
        this.disks.mountImage(id, data, filename);
      } catch (err) {
        return { ok: false, message: `Disk error: ${(err as Error).message}` };
      }
      if (id === 'a') {
        this.machine.bootDisc();
        return { ok: true, target: id, message: `Drive 1 loaded: ${filename} (booting)` };
      }
      return { ok: true, target: id, message: `Drive 2 loaded: ${filename}` };
    }
    if (ext === 'wav') {
      if (this.tape.mountWav(data, filename)) {
        return { ok: true, target: 'tape', message: `Tape loaded: ${filename}` };
      }
      return { ok: false, message: 'Not a readable WAVE cassette' };
    }
    return { ok: false, message: 'Apple II accepts .dsk, .do, .po and .wav' };
  }
}
