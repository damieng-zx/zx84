/**
 * LynxMediaService — what a dropped file means on this machine.
 *
 * Cassettes mount. Disks do not yet: `.ldf` is a headerless raw sector dump
 * for the FD1793 and lands with the disk increment, so it says so plainly
 * rather than mounting something that would not load.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { isLynxTap } from '@/media/tape/lynx-tap.ts';
import type { LynxMachine } from '../lynx-machine.ts';
import type { LynxTapeService } from './tape.ts';

export class LynxMediaService implements MediaService {
  constructor(
    private readonly m: LynxMachine,
    private readonly tape: LynxTapeService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return this.m.hasDisk
      ? [{ ext: '.tap', target: 'tape' }, { ext: '.ldf', target: 'a' }]
      : [{ ext: '.tap', target: 'tape' }];
  }

  async mount(
    data: Uint8Array,
    filename: string,
    _target?: MediaTargetId,
  ): Promise<MountResult> {
    if (/\.tap$/i.test(filename)) {
      // The extension is shared with the ZX Spectrum's unrelated .tap, so say
      // which one this is rather than letting the ROM fail to find a leader.
      if (!isLynxTap(data)) {
        return { ok: false, message: 'Not a Lynx cassette — .tap is also a ZX Spectrum format' };
      }
      if (!this.tape.mount(data, filename)) {
        return { ok: false, message: `Could not read ${filename} as a Lynx cassette` };
      }
      return { ok: true, target: 'tape', message: `Cassette: ${filename} — type ${this.loadHint()}` };
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

  /** The command that loads the tape's first program: BASIC takes LOAD,
   *  machine code takes MLOAD, and both want the name in quotes. */
  private loadHint(): string {
    const first = this.tape.entries[0];
    if (!first) return 'LOAD ""';
    return first.name ? `${first.command} "${first.name}"` : `${first.command} ""`;
  }
}
