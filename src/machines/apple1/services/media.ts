import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { Apple1Machine } from '../apple1-machine.ts';

/**
 * Apple I media routing. Software for the Apple I mostly circulates as listings:
 * a Monitor hex dump (`0280: A9 00 …` then `280R`) or a BASIC program, which is
 * typed in at the keyboard. A `.txt`/`.hex` file is therefore keyed in at the
 * pace the program reads it, exactly as a person would, rather than poked into
 * memory — so it works at the Monitor prompt, in BASIC, or in anything else
 * that reads the keyboard.
 */
export class Apple1MediaService implements MediaService {
  constructor(private readonly machine: Apple1Machine) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.txt', target: 'paste' },
      { ext: '.hex', target: 'paste' },
    ];
  }

  async mount(
    data: Uint8Array,
    filename: string,
    _target?: MediaTargetId,
  ): Promise<MountResult> {
    if (!/\.(txt|hex)$/i.test(filename)) {
      return { ok: false, message: 'The Apple I loads .txt and .hex listings' };
    }
    const keys = this.machine.typeText(new TextDecoder('latin1').decode(data));
    if (keys === 0) return { ok: false, message: `${filename} has nothing the keyboard can type` };
    return { ok: true, target: 'paste', message: `Typing ${filename} (${keys} keys)` };
  }
}
