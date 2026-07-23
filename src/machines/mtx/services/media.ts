import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';

/** Base MTX media routing; cassette and ROMPAK formats follow in later slices. */
export class MtxMediaService implements MediaService {
  accepts(): MediaTypeDescriptor[] { return []; }

  async mount(
    _data: Uint8Array,
    _filename: string,
    _target?: MediaTargetId,
  ): Promise<MountResult> {
    return { ok: false, message: 'MTX cassette and ROMPAK loading is not fitted yet' };
  }
}
