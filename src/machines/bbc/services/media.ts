import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { parseAcornDisc } from '@/media/floppy/acorn-disc.ts';
import type { BbcMachine } from '../bbc-machine.ts';
import type { BbcDiskService } from './disks.ts';
import type { AcornTapeService } from '@/machines/shared/acorn-tape-service.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { BBC_STATE_SPEC } from '../snapshots/bbc-state.ts';

/** The drive a mount target names: 'a' / 'b' directly, or the shell's
 *  family-agnostic `unit:N` hint (unit 0 = drive 0, unit 1 = drive 1). */
function driveOf(target: MediaTargetId | undefined): 'a' | 'b' {
  if (target === 'b') return 'b';
  const unit = /^unit:(\d+)$/.exec(target ?? '');
  return unit && Number(unit[1]) === 1 ? 'b' : 'a';
}

/** BBC media routing: Acorn DFS discs — raw dumps (.ssd/.dsd/.img) and HFE / SCP
 *  bitstream and flux images — and UEF/CSW cassette images. A disc loaded into
 *  drive 0 is auto-booted with SHIFT+BREAK, as a user would; a tape is mounted
 *  and waits for the user's *TAPE/CHAIN. */
export class BbcMediaService implements MediaService {
  constructor(
    private readonly machine: BbcMachine,
    private readonly disks: BbcDiskService,
    private readonly tape: AcornTapeService,
    private readonly snapshots: NativeSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.ssd', target: 'a' },
      { ext: '.dsd', target: 'a' },
      { ext: '.img', target: 'a' },
      { ext: '.hfe', target: 'a' },
      { ext: '.scp', target: 'a' },
      { ext: '.uef', target: 'tape' },
      { ext: '.csw', target: 'tape' },
      { ext: '.wav', target: 'tape' },
      { ext: BBC_STATE_SPEC.ext, target: 'snapshot' },
    ];
  }

  async mount(
    data: Uint8Array,
    filename: string,
    target?: MediaTargetId,
  ): Promise<MountResult> {
    if (/\.(?:ssd|dsd|img|hfe|scp)$/i.test(filename)) {
      const id = driveOf(target);
      if (id === 'b' && this.machine.driveCount < 2) {
        return { ok: false, message: 'Drive 1 is not fitted (change the drive count in the Drives pane)' };
      }
      // The shell remounting a disc after a browser-refresh restore names the
      // drive by its id: the restored machine is already running whatever was
      // on it, so the disc goes back in without a SHIFT+BREAK or a head move.
      const reattach = target === id && this.machine.refreshResumed;
      try {
        // .dsd is always two sides; a .img over a single-sided 80-track image
        // (204800 bytes) is taken as double-sided. HFE and SCP are decoded
        // track by track, whatever the file is called.
        const { image } = parseAcornDisc(data, filename, 'dfs');
        // The DFS (on either controller) reads single-density discs only: a
        // disc with no FM track at all — an ADFS or other double-density disc —
        // would just give "Disc fault" at every access.
        if (!image.tracks.some(row => row.some(t => t && t.sectors.length > 0 && t.encoding !== 'mfm'))) {
          return { ok: false, message: `${filename} is a double-density disc; the BBC's DFS reads single-density (FM) discs` };
        }
        if (reattach) this.disks.reattach(id, image, filename);
        else this.disks.insert(id, image, filename);
        if (id === 'a' && !reattach) this.machine.bootDisc();
        return {
          ok: true,
          target: id,
          message: id === 'a' && !reattach
            ? `Drive 0 loaded: ${filename} (SHIFT+BREAK)`
            : `Drive ${id === 'a' ? 0 : 1} loaded: ${filename}`,
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
    if (filename.toLowerCase().endsWith(BBC_STATE_SPEC.ext)) {
      const r = await this.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      // A state carries its own discs and tape: the panes re-read them.
      return r.ok
        ? { ok: true, target: 'snapshot', mediaChanged: true, message: r.message }
        : { ok: false, message: r.message };
    }
    return { ok: false, message: 'BBC accepts .ssd/.dsd/.img/.hfe/.scp disk images, .uef/.csw/.wav tapes and .bbcstate snapshots' };
  }
}
