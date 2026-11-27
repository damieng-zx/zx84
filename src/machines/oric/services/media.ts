/**
 * Oric media routing.
 *
 * A `.tap` mounts on the cassette deck, a plain-text BASIC listing is typed at
 * the keyboard at a readable pace exactly as a person would, and a native
 * `.oricstate` snapshot replaces the whole machine state.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { isOricTap } from '@/media/tape/oric-tap.ts';
import { isOricDsk, parseOricDsk } from '@/media/floppy/oric-dsk.ts';
import type { OricMachine } from '../oric-machine.ts';
import { ORIC_STATE_SPEC } from '../snapshots/oric-state.ts';
import type { OricTapeService } from './tape.ts';
import type { OricDiskService } from './disks.ts';

/** The extensions this machine's Load picker offers for tapes. */
export const ORIC_TAPE_EXTENSIONS = ['.tap'] as const;
/** The Microdisc's image extensions. `.dsk` is overloaded, so the signature decides. */
export const ORIC_DISK_EXTENSIONS = ['.dsk'] as const;

export class OricMediaService implements MediaService {
  constructor(
    private readonly machine: OricMachine,
    private readonly tape: OricTapeService,
    private readonly disks: OricDiskService,
    private readonly snapshots: NativeSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    const out: MediaTypeDescriptor[] = [
      { ext: '.txt', target: 'paste' },
      { ext: '.bas', target: 'paste' },
      ...ORIC_TAPE_EXTENSIONS.map((ext) => ({ ext, target: 'tape' })),
    ];
    // Only offer disks while the card is fitted: a `.dsk` dropped with none
    // would have nowhere to go.
    if (this.machine.microdisc) out.push({ ext: '.dsk', target: 'a' });
    out.push({ ext: ORIC_STATE_SPEC.ext, target: 'snapshot' });
    return out;
  }

  async mount(data: Uint8Array, filename: string, target?: MediaTargetId): Promise<MountResult> {
    if (filename.toLowerCase().endsWith(ORIC_STATE_SPEC.ext)) {
      const r = await this.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      return r.ok
        ? { ok: true, target: 'snapshot', message: r.message }
        : { ok: false, message: r.message };
    }
    if (filename.toLowerCase().endsWith('.tap')) {
      // `.tap` is also the Spectrum's format, which is unrelated. Say which one
      // this is rather than letting the ROM fail to find a leader.
      if (!isOricTap(data)) {
        return { ok: false, message: 'Not an Oric cassette — .tap is also a Spectrum format' };
      }
      if (!this.tape.mount(data, filename)) {
        return { ok: false, message: `Could not read ${filename} as an Oric cassette` };
      }
      return { ok: true, target: 'tape', message: `Cassette: ${filename} — type ${this.tape.command}` };
    }
    if (filename.toLowerCase().endsWith('.dsk')) {
      if (!this.machine.microdisc) {
        return { ok: false, message: 'No Microdisc is fitted (Hardware pane)' };
      }
      if (!isOricDsk(data)) {
        return { ok: false, message: `${filename} is not an Oric disk image` };
      }
      let image;
      try {
        image = parseOricDsk(data);
      } catch (error) {
        return { ok: false, message: `${filename}: ${(error as Error).message}` };
      }
      const id = driveIdFor(target);
      this.disks.insert(id, image, filename);
      return { ok: true, target: id, message: `Drive ${id.toUpperCase()}: ${filename}` };
    }
    if (!/\.(txt|bas)$/i.test(filename)) {
      return {
        ok: false,
        message: 'The Oric loads .txt/.bas BASIC listings, .tap cassettes, .dsk disks and .oricstate snapshots',
      };
    }
    const keys = this.machine.typeText(new TextDecoder('latin1').decode(data));
    if (keys === 0) return { ok: false, message: `${filename} has nothing the keyboard can type` };
    return { ok: true, target: 'paste', message: `Typing ${filename} (${keys} keys)` };
  }
}

/** The drive id a mount target names; the first drive by default. */
function driveIdFor(target: MediaTargetId | undefined): string {
  if (target && /^[a-d]$/.test(target)) return target;
  const unit = /^unit:(\d+)$/.exec(target ?? '');
  if (unit) return 'abcd'[Number(unit[1])] ?? 'a';
  const n = Number(target);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? 'abcd'[n - 1] : 'a';
}
