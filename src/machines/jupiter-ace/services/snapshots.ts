/**
 * Jupiter Ace SnapshotService: zx84's own `.acestate` (exact, saved and
 * loaded; see snapshots/ace-state.ts) and xAce's `.ace` memory snapshots
 * (loaded only; see snapshots/ace-snapshot.ts).
 */

import type { MachineHost, SnapshotApplyResult } from '@/machines/machine.ts';
import { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import type { JupiterAceMachine } from '../ace-machine.ts';
import { ACE_STATE } from '../snapshots/ace-state.ts';
import { parseAceSnapshot } from '../snapshots/ace-snapshot.ts';

export class AceSnapshotService extends NativeSnapshotService {
  constructor(private readonly ace: JupiterAceMachine, host: () => MachineHost | null) {
    super(ACE_STATE, ace, host);
  }

  override formats(): { ext: string; canSave: boolean }[] {
    return [...super.formats(), { ext: '.ace', canSave: false }];
  }

  override async apply(data: Uint8Array, filename: string): Promise<SnapshotApplyResult> {
    if (!/\.ace$/i.test(filename)) return super.apply(data, filename);
    try {
      const snap = parseAceSnapshot(data);
      this.ace.stop();
      try {
        this.ace.loadAceSnapshot(snap);
      } finally {
        void this.ace.start();
      }
      return { ok: true, message: `Loaded Jupiter Ace snapshot: ${filename}` };
    } catch (e) {
      return { ok: false, message: `Error: ${(e as Error).message}` };
    }
  }
}
