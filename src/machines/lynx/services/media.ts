/**
 * LynxMediaService — what a dropped file means on this machine.
 *
 * Nothing mounts yet: the Lynx's `.tap` is its own container (a quoted name, a
 * type byte and the payload) rather than the ZX Spectrum's, and its `.ldf`
 * disks are headerless raw sector dumps for the FD1793. Both arrive with the
 * cassette and disk increments; until then this says so plainly rather than
 * mounting something that would not load.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { LynxMachine } from '../lynx-machine.ts';

export class LynxMediaService implements MediaService {
  constructor(private readonly m: LynxMachine) {}

  accepts(): MediaTypeDescriptor[] {
    return this.m.hasDisk
      ? [{ ext: '.tap', target: 'tape' }, { ext: '.ldf', target: 'a' }]
      : [{ ext: '.tap', target: 'tape' }];
  }

  async mount(
    _data: Uint8Array,
    filename: string,
    _target?: MediaTargetId,
  ): Promise<MountResult> {
    if (/\.tap$/i.test(filename)) {
      return { ok: false, message: 'Lynx cassette support is not fitted yet' };
    }
    if (/\.ldf$/i.test(filename)) {
      return {
        ok: false,
        message: this.m.hasDisk
          ? 'Lynx disk support is not fitted yet'
          : 'The Lynx 48K has no disk interface',
      };
    }
    return { ok: false, message: 'The Lynx accepts .tap cassettes and .ldf disks' };
  }
}
