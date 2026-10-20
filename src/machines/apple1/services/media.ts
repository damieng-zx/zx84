import type { MediaService, MediaTypeDescriptor, MountResult } from '@/machines/machine.ts';

/** The bare Apple I takes no media: software is typed in at the Monitor. The
 *  cassette interface and hex-dump loading arrive with their own devices. */
export class Apple1MediaService implements MediaService {
  accepts(): MediaTypeDescriptor[] { return []; }

  async mount(): Promise<MountResult> {
    return { ok: false, message: 'The Apple I has no media to load yet' };
  }
}
