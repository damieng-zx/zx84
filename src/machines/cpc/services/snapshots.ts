/**
 * CPC SnapshotService — `.SNA` apply and save (CPCEMU/WinAPE format).
 *
 * A CPC snapshot is taken on a specific model (464/664/6128 differ in RAM size
 * and ROM set). When the file's model differs from the running machine the
 * service asks the host to rebuild as that model (host.requestModel) and reports
 * `needsReplay` — the shell re-dispatches the same file to the machine the
 * rebuild produced (which matches, so the replayed apply cannot recurse). This
 * mirrors the Spectrum's 128K-upgrade flow.
 */

import type { MachineHost, SnapshotApplyResult, SnapshotService } from '@/machines/machine.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { readCpcSnaModel, applyCpcSna, saveCpcSna } from '@/machines/cpc/snapshots/cpc-sna.ts';

export class CpcSnapshotService implements SnapshotService {
  constructor(private readonly c: CpcMachine, private readonly host: () => MachineHost | null) {}

  formats(): { ext: string; canSave: boolean }[] {
    return [{ ext: '.sna', canSave: true }];
  }

  async apply(data: Uint8Array, filename: string): Promise<SnapshotApplyResult> {
    let info;
    try {
      info = readCpcSnaModel(data);
    } catch (e) {
      return { ok: false, message: `SNA error: ${(e as Error).message}` };
    }

    // Auto-switch the running machine to the snapshot's model before applying.
    if (info.model !== this.c.model) {
      const host = this.host();
      if (host && await host.requestModel(info.model, `${info.model} SNA: ${filename}`)) {
        return { ok: true, needsReplay: true, message: '' };
      }
      return { ok: false, message: 'SNA load needs a matching CPC model' };
    }

    this.c.stop();
    try {
      applyCpcSna(data, this.c);
      return { ok: true, message: `Loaded ${info.model} SNA v${info.version}: ${filename}` };
    } catch (e) {
      return { ok: false, message: `SNA error: ${(e as Error).message}` };
    } finally {
      this.c.start();
    }
  }

  /** Serialize the running machine as a `.SNA` (v2 = flat, v3 = RLE-compressed). */
  saveSna(version: 2 | 3): Uint8Array {
    return saveCpcSna(this.c, version);
  }

  async save(ext: string): Promise<Uint8Array> {
    return this.saveSna(ext === '2' || ext === 'v2' ? 2 : 3);
  }
}
