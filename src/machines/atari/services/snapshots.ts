/**
 * Atari SnapshotService: zx84's own `.a8state` (see snapshots/atari-state.ts).
 *
 * Applying one stops the machine, restores it exactly and starts it again. A
 * snapshot of a different Atari model asks the host for that model and reports
 * `needsReplay`, as the Spectrum does for a 128K snapshot on a 48K; one from the
 * other TV standard is refused, since the clock and frame length differ.
 */

import type {
  MachineHost, SnapshotApplyResult, SnapshotService,
} from '@/machines/machine.ts';
import type { AtariMachine } from '../atari-machine.ts';
import {
  decodeAtariState, romMismatch, saveAtariState, saveAtariStateSync,
} from '../snapshots/atari-state.ts';
import { atariModelName } from '../models.ts';

export const ATARI_STATE_EXT = '.a8state';

export class AtariSnapshotService implements SnapshotService {
  constructor(private readonly m: AtariMachine, private readonly host: () => MachineHost | null) {}

  formats(): { ext: string; canSave: boolean }[] {
    return [{ ext: ATARI_STATE_EXT, canSave: true }];
  }

  async apply(data: Uint8Array, filename: string): Promise<SnapshotApplyResult> {
    const m = this.m;
    try {
      const { info, body } = await decodeAtariState(data);
      if (info.region !== m.region) {
        return {
          ok: false,
          message: `${filename} was saved on a ${info.region.toUpperCase()} machine; this one is ${m.region.toUpperCase()}. Change the region and load it again`,
        };
      }
      if (info.model !== m.model) {
        const host = this.host();
        if (host && await host.requestModel(info.model, `Atari snapshot: ${filename}`)) {
          return { ok: true, needsReplay: true, message: '' };
        }
        return { ok: false, message: `${filename} is for the Atari ${atariModelName(info.model)}; switch to it first` };
      }
      m.stop();
      try {
        m.loadState(body);
      } catch (e) {
        // Past the container checks, so only a bug or a hand-built file gets
        // here; the machine may be half-restored, so start it over.
        m.reset();
        void m.start();
        return { ok: false, message: `Error: ${(e as Error).message}` };
      }
      void m.start();
      return { ok: true, message: `Loaded Atari snapshot: ${filename}${romMismatch(m, info)}` };
    } catch (e) {
      return { ok: false, message: `Error: ${(e as Error).message}` };
    }
  }

  async save(ext: string): Promise<Uint8Array> {
    if (ext.replace(/^\./, '') !== ATARI_STATE_EXT.slice(1)) throw new Error(`Unsupported snapshot save format: ${ext}`);
    return saveAtariState(this.m);
  }

  saveSync(): Uint8Array {
    return saveAtariStateSync(this.m);
  }

  /** Restore a `saveSync()` blob on the same model (browser-refresh resume). */
  async restoreSync(data: Uint8Array): Promise<boolean> {
    const m = this.m;
    try {
      const { info, body } = await decodeAtariState(data);
      if (info.model !== m.model || info.region !== m.region) return false;
      m.stop();
      m.loadState(body);
    } catch {
      return false;
    }
    void m.start();
    return true;
  }
}
