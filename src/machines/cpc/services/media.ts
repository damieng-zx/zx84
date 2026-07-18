/**
 * CPC MediaService — the machine's own file routing, ported verbatim from the
 * shell's per-extension CPC cascade (emulator.loadFile's asCpc branch, plus
 * loadCpcSnapshot and the CPC half of loadDiskToUnit).
 *
 * The service mutates the machine only. Signals, persistence and downloads stay
 * shell reflection, keyed off MountResult.target.
 */

import type { MediaService, MediaTypeDescriptor, MediaTargetId, MountResult } from '@/machines/machine.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { parseFloppyImage } from '@/media/floppy/hfe.ts';
import type { CpcTapeService } from './tape.ts';
import type { CpcDiskService } from './disks.ts';
import type { CpcSnapshotService } from './snapshots.ts';

function fail(message: string): MountResult { return { ok: false, message }; }

export class CpcMediaService implements MediaService {
  constructor(
    private readonly c: CpcMachine,
    private readonly disks: CpcDiskService,
    private readonly tape: CpcTapeService,
    private readonly snapshots: CpcSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    const out: MediaTypeDescriptor[] = [
      { ext: '.sna', target: 'snapshot' },
      { ext: '.cdt', target: 'tape' },
    ];
    if (this.c.config.hasFDC) out.push({ ext: '.dsk', target: 'a' }, { ext: '.hfe', target: 'a' });
    return out;
  }

  private static unitOf(target: MediaTargetId | undefined): number {
    if (target === 'b') return 1;
    if (target && target.startsWith('unit:')) return Number(target.slice(5));
    return 0;
  }

  async mount(data: Uint8Array, filename: string, target?: MediaTargetId): Promise<MountResult> {
    const c = this.c;

    // Cassettes: CDT/TZX (same container) or TAP.
    if (/\.(cdt|tzx|tap)$/i.test(filename)) {
      c.stop();
      let blocks: TapeBlock[];
      try {
        blocks = /\.tap$/i.test(filename) ? c.tape.parseTAP(data) : parseTZX(data);
      } catch (e) {
        c.start();
        return fail(`Error: ${(e as Error).message}`);
      }
      this.tape.mountBlocks(blocks, filename);
      c.start();
      return { ok: true, target: 'tape', message: `Tape loaded: ${filename}` };
    }

    // Snapshots (may trigger a model rebuild → replay).
    if (/\.sna$/i.test(filename)) {
      const r = await this.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      return r.ok ? { ok: true, target: 'snapshot', message: r.message } : fail(r.message);
    }

    // Disk images into the uPD765A.
    if (/\.(dsk|hfe|scp)$/i.test(filename)) {
      const unit = CpcMediaService.unitOf(target);
      c.stop();
      try {
        const image = parseFloppyImage(data);
        this.disks.insert(unit === 0 ? 'a' : 'b', image, filename);
        return { ok: true, target: unit === 0 ? 'a' : 'b', message: `Disk ${unit === 0 ? 'A' : 'B'}: loaded: ${filename}` };
      } catch (e) {
        return fail(`DSK error: ${(e as Error).message}`);
      } finally {
        c.start();
      }
    }

    return fail('CPC accepts .sna, .dsk, .hfe, .scp, .cdt, .tzx and .tap files');
  }
}
