import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { parseMtxMfloppy } from '@/media/floppy/mtx-mfloppy.ts';
import type { MtxTapeService } from './tape.ts';
import type { MtxDiskService } from './disks.ts';
import type { MtxRomService } from './roms.ts';

/** MTX media routing: ROM packs, logical tapes, and Type 03/07 floppy disks. */
export class MtxMediaService implements MediaService {
  constructor(
    private readonly tape: MtxTapeService,
    private readonly disks: MtxDiskService,
    private readonly roms: MtxRomService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.rom', target: 'cartridge' },
      { ext: '.mtx', target: 'tape' },
      { ext: '.mfloppy', target: 'a' },
      { ext: '.mfloppy-03', target: 'a' },
      { ext: '.mfloppy-07', target: 'a' },
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
    if (/\.mfloppy(?:-(?:03|07))?$/i.test(filename)) {
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
      message: 'MTX accepts .rom packs, .mtx cassettes, and Type 03/07 .mfloppy disks',
    };
  }
}
