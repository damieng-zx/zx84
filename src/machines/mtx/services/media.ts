import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { parseHFE } from '@/media/floppy/hfe.ts';
import { parseMtxMfloppy } from '@/media/floppy/mtx-mfloppy.ts';
import type { MtxTapeService } from './tape.ts';
import type { MtxDiskService } from './disks.ts';
import type { MtxRomService } from './roms.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';

/** MTX media routing: ROM packs, logical tapes, HFE / Type 03/07 floppy disks
 *  and `.mtxstate` snapshots. */
export class MtxMediaService implements MediaService {
  constructor(
    private readonly tape: MtxTapeService,
    private readonly disks: MtxDiskService,
    private readonly roms: MtxRomService,
    private readonly snapshots: NativeSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.rom', target: 'cartridge' },
      { ext: '.mtx', target: 'tape' },
      { ext: '.hfe', target: 'a' },
      { ext: '.mfloppy', target: 'a' },
      { ext: '.mfloppy-03', target: 'a' },
      { ext: '.mfloppy-07', target: 'a' },
      { ext: '.mtxstate', target: 'snapshot' },
    ];
  }

  async mount(
    data: Uint8Array,
    filename: string,
    target?: MediaTargetId,
  ): Promise<MountResult> {
    if (/\.rom$/i.test(filename)) {
      try {
        this.roms.cartridge.insert(data, filename);
        return {
          ok: true,
          target: 'cartridge',
          message: `ROM pack: ${filename} — type ROM 2`,
        };
      } catch (err) {
        return { ok: false, message: `ROM pack error: ${(err as Error).message}` };
      }
    }
    if (/\.mtxstate$/i.test(filename)) {
      const r = await this.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      // A state carries its own disks and ROM pack: the panes re-read them.
      return r.ok
        ? { ok: true, target: 'snapshot', mediaChanged: true, message: r.message }
        : { ok: false, message: r.message };
    }
    if (/\.mtx$/i.test(filename)) {
      if (!this.tape.mount(data, filename)) {
        return { ok: false, message: 'Invalid MTX cassette image (the 18-byte header is missing)' };
      }
      return {
        ok: true,
        target: 'cas',
        message: `Cassette: ${filename} — type LOAD or VERIFY`,
      };
    }
    if (/\.(?:hfe|mfloppy(?:-(?:03|07))?)$/i.test(filename)) {
      const hfe = /\.hfe$/i.test(filename);
      if (this.disks.drives.length === 0) {
        return { ok: false, message: 'Enable the FDX floppy subsystem first' };
      }
      const unit = target === 'b' ? 1 : target?.startsWith('unit:') ? Number(target.slice(5)) : 0;
      if (!Number.isInteger(unit) || unit < 0 || unit >= this.disks.drives.length) {
        return { ok: false, message: 'that drive is not fitted' };
      }
      try {
        const id = unit === 1 ? 'b' : 'a';
        this.disks.insert(id, hfe ? parseHFE(data) : parseMtxMfloppy(data), filename);
        return {
          ok: true,
          target: id,
          message: `${id === 'a' ? 'Drive B:' : 'Drive C:'} loaded: ${filename}`,
        };
      } catch (err) {
        return { ok: false, message: `${hfe ? 'HFE' : 'MFLOPPY'} error: ${(err as Error).message}` };
      }
    }
    return {
      ok: false,
      message: 'MTX accepts .rom packs, .mtx cassettes, .hfe or Type 03/07 .mfloppy disks and .mtxstate snapshots',
    };
  }
}
