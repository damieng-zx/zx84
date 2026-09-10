/**
 * LynxMediaService — what a dropped file means on this machine.
 *
 * Cassettes mount, and on the 96K/128K so do raw `.ldf` disk dumps. The 48K has
 * no disk interface, so `.ldf` is refused rather than mounted into nothing.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { isLynxTap } from '@/media/tape/lynx-tap.ts';
import { parseLdf } from '@/media/floppy/ldf-image.ts';
import type { LynxMachine } from '../lynx-machine.ts';
import type { LynxTapeService } from './tape.ts';
import type { LynxDiskService } from './disks.ts';

/** The drive id a mount target names: 'a'..'d' directly, a shell `unit:N`
 *  (0-based), or 1..4 numerically. Defaults to A:. */
function driveIdFor(target: MediaTargetId | undefined): string {
  if (target && /^[a-d]$/.test(target)) return target;
  const unit = /^unit:(\d+)$/.exec(target ?? '');
  if (unit) return 'abcd'[Number(unit[1])] ?? 'a';
  const n = Number(target);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? 'abcd'[n - 1] : 'a';
}

export class LynxMediaService implements MediaService {
  constructor(
    private readonly m: LynxMachine,
    private readonly disks: LynxDiskService,
    private readonly tape: LynxTapeService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    const out: MediaTypeDescriptor[] = [{ ext: '.tap', target: 'tape' }];
    if (this.m.hasDisk) out.push({ ext: '.ldf', target: 'a' });
    return out;
  }

  async mount(
    data: Uint8Array,
    filename: string,
    target?: MediaTargetId,
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
      if (!this.m.hasDisk) {
        return { ok: false, message: 'The Lynx 48K has no disk interface' };
      }
      const image = parseLdf(data);
      if (!image) {
        return {
          ok: false,
          message: `${filename} is not a Lynx disk image (expected a 200K or 800K .ldf dump)`,
        };
      }
      const id = driveIdFor(target);
      this.disks.insert(id, image, filename);
      return { ok: true, target: id, message: `Drive ${id.toUpperCase()}: ${filename}` };
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
