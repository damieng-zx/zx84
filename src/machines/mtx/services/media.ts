import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { MtxTapeService } from './tape.ts';

/** MTX media routing. `.mtx` is the emulator-standard logical tape stream. */
export class MtxMediaService implements MediaService {
  constructor(private readonly tape: MtxTapeService) {}

  accepts(): MediaTypeDescriptor[] {
    return [{ ext: '.mtx', target: 'tape' }];
  }

  async mount(
    data: Uint8Array,
    filename: string,
    _target?: MediaTargetId,
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
    return { ok: false, message: 'MTX accepts .mtx cassette images' };
  }
}
