import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import type { AtomMachine } from '../atom-machine.ts';
import { ATOM_TAPE_EXTENSIONS, type AtomTape } from '../atom-tape.ts';
import { ATOM_STATE_SPEC } from '../snapshots/atom-state.ts';

/**
 * Atom media routing.
 *
 * Tapes (UEF, CSW or WAVE) go to the pulse-level deck; a plain-text BASIC
 * listing is typed at the keyboard at a readable pace, exactly as a person
 * would. A native `.atmstate` snapshot replaces the whole machine state.
 */
export class AtomMediaService implements MediaService {
  constructor(
    private readonly machine: AtomMachine,
    private readonly tape: AtomTape,
    private readonly snapshots: NativeSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.txt', target: 'paste' },
      { ext: '.bas', target: 'paste' },
      ...ATOM_TAPE_EXTENSIONS.map((ext) => ({ ext, target: 'tape' })),
      { ext: ATOM_STATE_SPEC.ext, target: 'snapshot' },
    ];
  }

  async mount(data: Uint8Array, filename: string, _target?: MediaTargetId): Promise<MountResult> {
    if (filename.toLowerCase().endsWith(ATOM_STATE_SPEC.ext)) {
      const r = await this.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      return r.ok
        ? { ok: true, target: 'snapshot', message: r.message }
        : { ok: false, message: r.message };
    }
    if (ATOM_TAPE_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext))) {
      if (!await this.tape.mountBytes(data, filename)) {
        return { ok: false, message: `Not a readable Atom cassette: ${filename}` };
      }
      return { ok: true, target: 'tape', message: `Tape loaded: ${filename}` };
    }
    if (!/\.(txt|bas)$/i.test(filename)) {
      return {
        ok: false,
        message: 'The Atom loads .txt/.bas BASIC listings, .uef/.csw/.wav cassette tapes and .atmstate snapshots',
      };
    }
    const keys = this.machine.typeText(new TextDecoder('latin1').decode(data));
    if (keys === 0) return { ok: false, message: `${filename} has nothing the keyboard can type` };
    return { ok: true, target: 'paste', message: `Typing ${filename} (${keys} keys)` };
  }
}
