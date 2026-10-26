import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { Apple1Machine } from '../apple1-machine.ts';
import type { Apple1TapeService } from './tape.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { APPLE1_STATE_SPEC } from '../snapshots/apple1-state.ts';

/**
 * Apple I media routing.
 *
 * Software for the Apple I mostly circulates as listings: a Monitor hex dump
 * (`0280: A9 00 …` then `280R`) or a BASIC program, which is typed in at the
 * keyboard. A `.txt`/`.hex` file is therefore keyed in at the pace the program
 * reads it, exactly as a person would, rather than poked into memory — so it
 * works at the Monitor prompt, in BASIC, or in anything else that reads the
 * keyboard. A `.wav` recording goes on the cassette deck when the Apple Cassette
 * Interface is fitted.
 */
export class Apple1MediaService implements MediaService {
  constructor(
    private readonly machine: Apple1Machine,
    private readonly tape: Apple1TapeService,
    private readonly snapshots: NativeSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    const types: MediaTypeDescriptor[] = [
      { ext: '.txt', target: 'paste' },
      { ext: '.hex', target: 'paste' },
      { ext: APPLE1_STATE_SPEC.ext, target: 'snapshot' },
    ];
    if (this.machine.options.aci) types.push({ ext: '.wav', target: 'tape' });
    return types;
  }

  async mount(
    data: Uint8Array,
    filename: string,
    _target?: MediaTargetId,
  ): Promise<MountResult> {
    if (/\.wav$/i.test(filename)) {
      if (!this.machine.options.aci) {
        return { ok: false, message: 'Fit the Apple Cassette Interface (Hardware pane) to load a tape' };
      }
      if (!this.tape.mountWav(data, filename)) {
        return { ok: false, message: 'Not a readable WAVE cassette' };
      }
      return { ok: true, target: 'tape', message: `Tape loaded: ${filename}` };
    }
    if (filename.toLowerCase().endsWith(APPLE1_STATE_SPEC.ext)) {
      const r = await this.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      // A state carries its own tape: the panes re-read it.
      return r.ok
        ? { ok: true, target: 'snapshot', mediaChanged: true, message: r.message }
        : { ok: false, message: r.message };
    }
    if (!/\.(txt|hex)$/i.test(filename)) {
      return { ok: false, message: 'The Apple I loads .txt and .hex listings, .a1state snapshots, and .wav tapes with the cassette interface' };
    }
    const keys = this.machine.typeText(new TextDecoder('latin1').decode(data));
    if (keys === 0) return { ok: false, message: `${filename} has nothing the keyboard can type` };
    return { ok: true, target: 'paste', message: `Typing ${filename} (${keys} keys)` };
  }
}
