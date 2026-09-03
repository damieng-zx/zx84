/**
 * SAM SnapshotService — refresh-resume only.
 *
 * The SAM has no snapshot interchange format worth supporting: SimCoupe, the
 * reference emulator, has none at all. So this service deliberately offers no
 * file formats — `formats()` is empty and the Save menu shows no snapshot
 * entries — and exists purely to satisfy the shell's browser-refresh resume
 * path, which is gated on `saveSync` being present.
 *
 * `apply()` and `save()` are here because the SPI requires them; both refuse,
 * rather than pretending to a format that does not exist.
 */

import type {
  SnapshotApplyResult, SnapshotService,
} from '@/machines/machine.ts';
import type { SamMachine } from '../sam-machine.ts';
import { applySamState, serializeSamState } from '../snapshots/sam-state.ts';

export class SamSnapshotService implements SnapshotService {
  constructor(private readonly m: SamMachine) {}

  /** No interchange formats — see the note above. */
  formats(): { ext: string; canSave: boolean }[] { return []; }

  async apply(_data: Uint8Array, filename: string): Promise<SnapshotApplyResult> {
    return { ok: false, message: `The SAM has no snapshot format: ${filename}` };
  }

  async save(ext: string): Promise<Uint8Array> {
    throw new Error(`The SAM has no snapshot format to save as '${ext}'`);
  }

  /**
   * Full machine state for the browser-refresh path. Must be synchronous: the
   * shell calls this from a `beforeunload` handler.
   */
  saveSync(): Uint8Array | null {
    try {
      return serializeSamState(this.m, this.m.model);
    } catch {
      return null;
    }
  }

  /** Restore a `saveSync` blob onto the same model. */
  async restoreSync(data: Uint8Array): Promise<boolean> {
    try {
      if (!applySamState(this.m, this.m.model, data)) return false;
      // The keyboard is host state, not machine state: whatever was held down
      // when the page went away is certainly not held now.
      this.m.keyboard.reset();
      this.m.joystick.reset();
      this.m.requestRedraw();
      return true;
    } catch {
      return false;
    }
  }
}
