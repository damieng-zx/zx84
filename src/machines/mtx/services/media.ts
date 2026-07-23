import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { parseMtxMfloppy } from '@/media/floppy/mtx-mfloppy.ts';
import type { MtxTapeService } from './tape.ts';
import type { MtxDiskService } from './disks.ts';

/** MTX media routing: logical `.mtx` tapes and Type 07 `.mfloppy` disks. */
export class MtxMediaService implements MediaService {
  constructor(
    private readonly tape: MtxTapeService,
    private readonly disks: MtxDiskService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.mtx', target: 'tape' },
      { ext: '.mfloppy', target: 'a' },
      { ext: '.mfloppy-07', target: 'a' },
    ];
  }

  async mount(
    data: Uint8Array,
    filename: string,
    target?: MediaTargetId,
  ): Promise<MountResult> {
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
    if (/\.mfloppy(?:-07)?$/i.test(filename)) {
      try {
        const id = target === 'b' || target === 'unit:1' ? 'b' : 'a';
        this.disks.insert(id, parseMtxMfloppy(data), filename);
        return {
          ok: true,
          target: id,
          message: `${id === 'a' ? 'Drive B:' : 'Drive C:'} loaded: ${filename}`,
        };
      } catch (err) {
        return { ok: false, message: `MFLOPPY error: ${(err as Error).message}` };
      }
    }
    return {
      ok: false,
      message: 'MTX accepts .mtx cassette and .mfloppy/.mfloppy-07 disk images',
    };
  }
}
