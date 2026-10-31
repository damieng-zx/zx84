import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { Apple2Machine } from '../apple2-machine.ts';
import type { Apple2DiskService } from './disks.ts';
import type { Apple2TapeService } from './tape.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { APPLE2_STATE_SPEC } from '../snapshots/apple2-state.ts';

/** Disk image extensions; the contents, not the name, decide the format. */
const DISK_EXTENSIONS = ['dsk', 'do', 'po', 'd13', 'nib', 'woz', '2mg', '2img'];

/** Apple II media routing: 5.25" disk images into the Disk II drives — sector
 *  images (`.dsk`/`.do`/`.po`, 13-sector `.d13`), `.2mg`, raw-nibble `.nib` and
 *  bit-level `.woz` — and `.wav` cassette recordings onto the tape deck. A disk
 *  mounted in drive 1 boots, as a reset does. */
export class Apple2MediaService implements MediaService {
  constructor(
    private readonly machine: Apple2Machine,
    private readonly disks: Apple2DiskService,
    private readonly tape: Apple2TapeService,
    private readonly snapshots: NativeSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.dsk', target: 'a' },
      { ext: '.do', target: 'a' },
      { ext: '.po', target: 'a' },
      { ext: '.d13', target: 'a' },
      { ext: '.nib', target: 'a' },
      { ext: '.woz', target: 'a' },
      { ext: '.2mg', target: 'a' },
      { ext: '.2img', target: 'a' },
      { ext: '.wav', target: 'tape' },
      { ext: APPLE2_STATE_SPEC.ext, target: 'snapshot' },
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
    if (DISK_EXTENSIONS.includes(ext)) {
      const id = Apple2MediaService.driveOf(target);
      // The shell remounting a disk after a browser-refresh restore names the
      // drive by its id: the restored machine is already running whatever was
      // on it, so the disk goes back in without a reboot or a head move.
      const reattach = target === id && this.machine.refreshResumed;
      try {
        if (reattach) this.disks.reattachImage(id, data, filename);
        else this.disks.mountImage(id, data, filename);
      } catch (err) {
        return { ok: false, message: `Disk error: ${(err as Error).message}` };
      }
      if (reattach) return { ok: true, target: id, message: `Drive ${id === 'a' ? 1 : 2} loaded: ${filename}` };
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
    if (filename.toLowerCase().endsWith(APPLE2_STATE_SPEC.ext)) {
      const r = await this.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      // A state carries its own disks and tape: the panes re-read them.
      return r.ok
        ? { ok: true, target: 'snapshot', mediaChanged: true, message: r.message }
        : { ok: false, message: r.message };
    }
    return { ok: false, message: 'Apple II accepts .dsk, .do, .po, .d13, .nib, .woz, .2mg, .wav and .a2state' };
  }
}
