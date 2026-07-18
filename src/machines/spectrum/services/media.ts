/**
 * Spectrum MediaService — the machine's own file routing, ported verbatim from
 * the shell's per-extension cascade (emulator.ts loadFile tail + the
 * MediaManager's Spectrum half). The ORDER of these checks is load-bearing:
 * a .hfe/.scp flux image targets whichever WD-family interface is active — the
 * Beta Disk first, then the +D on a +D-capable machine with no built-in FDC
 * (the +3 has its own uPD765A and is never +D-capable); on a +3 they fall
 * through to the uPD765A path.
 *
 * The service mutates the machine only. Signals, persistence and downloads
 * stay shell reflection, keyed off MountResult.target.
 */

import type { MediaService, MediaTypeDescriptor, MediaTargetId, MountResult } from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { isInterface1Capable, isInterface2Capable } from '@/machines/spectrum/models.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { parseCSW } from '@/media/tape/csw.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { parseFloppyImage } from '@/media/floppy/hfe.ts';
import { parsePlusDMedia, parseBetaMedia, type SpectrumDiskService } from './disks.ts';
import type { SpectrumTapeService } from './tape.ts';
import type { SpectrumSnapshotService } from './snapshots.ts';
import type { SpectrumRomService } from './roms.ts';

function fail(message: string): MountResult { return { ok: false, message }; }

export class SpectrumMediaService implements MediaService {
  constructor(
    private readonly s: Spectrum,
    private readonly disks: SpectrumDiskService,
    private readonly tape: SpectrumTapeService,
    private readonly snapshots: SpectrumSnapshotService,
    private readonly roms: SpectrumRomService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    const s = this.s;
    const out: MediaTypeDescriptor[] = [
      { ext: '.sna', target: 'snapshot' },
      { ext: '.z80', target: 'snapshot' },
      { ext: '.szx', target: 'snapshot' },
      { ext: '.sp', target: 'snapshot' },
      { ext: '.tap', target: 'tape' },
      { ext: '.tzx', target: 'tape' },
      { ext: '.csw', target: 'tape' },
    ];
    if (s.variant.hasFDC) out.push({ ext: '.dsk', target: 'a' }, { ext: '.hfe', target: 'a' });
    if (isInterface1Capable(s.model)) out.push({ ext: '.mdr', target: 'mdv:0' }, { ext: '.mdv', target: 'mdv:0' });
    if (isInterface2Capable(s.model)) out.push({ ext: '.rom', target: 'cartridge' });
    return out;
  }

  /** Unit number for a drive-family target ('beta:1' → 1). The shell may also
   *  pass a family-agnostic 'unit:N' hint ("unit N of whatever device this
   *  routes to") — the old loadFile(unit) parameter. */
  private static unitOf(target: MediaTargetId | undefined, prefix: string, fallback: number): number {
    if (target && target.startsWith(prefix)) return Number(target.slice(prefix.length));
    if (target && target.startsWith('unit:')) return Number(target.slice(5));
    return fallback;
  }

  async mount(data: Uint8Array, filename: string, target?: MediaTargetId): Promise<MountResult> {
    const s = this.s;

    // ZX Interface 2 ROM cartridges (16K/48K only).
    if (/\.rom$/i.test(filename) && isInterface2Capable(s.model)) {
      const slot = this.roms.cartridge;
      if (!slot) return fail('Cartridges need a 16K/48K Spectrum');
      slot.insert(data, filename);
      return { ok: true, target: 'cartridge', message: `Cartridge: ${filename}` };
    }

    // Beta Disk (TR-DOS) images route to the WD1793.
    if (/\.(trd|scl)$/i.test(filename)) return this.mountBeta(data, filename, target);

    // MGT +D images route to the WD1772, not the +3 DSK path.
    if (/\.(mgt|img)$/i.test(filename)) return this.mountPlusD(data, filename, target);

    // A .hfe/.scp flux image targets whichever WD-family interface is active
    // (see the file header for why this ordering matters).
    if (/\.(hfe|scp)$/i.test(filename) && s.betaDisk.enabled) {
      return this.mountBeta(data, filename, target);
    }
    if (/\.(hfe|scp)$/i.test(filename) && s.mgtPlusD.enabled && !s.variant.hasFDC) {
      return this.mountPlusD(data, filename, target);
    }

    // ZX Interface 1 microdrive cartridges route to the IF1.
    if (/\.(mdr|mdv)$/i.test(filename)) {
      if (!s.interface1.enabled) return fail('Enable the ZX Interface 1 in Hardware first');
      const unit = SpectrumMediaService.unitOf(target, 'mdv:', 0);
      try {
        this.disks.insert(`mdv:${unit}`, data, filename);
        return { ok: true, target: `mdv:${unit}`, message: `Microdrive ${unit + 1}: loaded: ${filename}` };
      } catch (e) {
        return fail(`Microdrive error: ${(e as Error).message}`);
      }
    }

    const ext = filename.toLowerCase().split('.').pop();

    // Cassettes: TAP/TZX/CDT (same container) or CSW.
    if (ext === 'tap' || ext === 'tzx' || ext === 'cdt' || ext === 'csw') {
      // Stop the machine first to prevent the frame loop from interfering.
      s.stop();
      let blocks: TapeBlock[];
      try {
        if (ext === 'tzx' || ext === 'cdt') blocks = parseTZX(data);
        else if (ext === 'csw') blocks = await parseCSW(data);
        else blocks = s.tape.parseTAP(data);
      } catch (e) {
        s.start();
        return fail(`Error: ${(e as Error).message}`);
      }
      this.tape.mountBlocks(blocks, filename);
      s.start();
      return { ok: true, target: 'tape', message: `Tape loaded: ${filename}` };
    }

    // +3 internal drives (uPD765A).
    if (ext === 'dsk' || ext === 'hfe' || ext === 'scp') {
      const unit = target === 'b' ? 1 : SpectrumMediaService.unitOf(target, 'fdc:', 0);
      // Stop the frame loop before swapping the image so the FDC can't be
      // mid-operation when its disk is replaced.
      s.stop();
      try {
        const image = parseFloppyImage(data);
        this.disks.insert(unit === 0 ? 'a' : 'b', image, filename);
        return { ok: true, target: unit === 0 ? 'a' : 'b', message: `Disk ${unit === 0 ? 'A' : 'B'}: loaded: ${filename}` };
      } catch (e) {
        return fail(`DSK error: ${(e as Error).message}`);
      } finally {
        s.start();
      }
    }

    // Snapshots.
    if (ext === 'sna' || ext === 'z80' || ext === 'szx' || ext === 'sp') {
      const r = await this.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      return r.ok ? { ok: true, target: 'snapshot', message: r.message } : fail(r.message);
    }

    return fail(`Unknown file type: .${ext}`);
  }

  private mountBeta(data: Uint8Array, filename: string, target?: MediaTargetId): MountResult {
    const s = this.s;
    if (!s.betaDisk.enabled) return fail('Enable the Beta Disk in Hardware first');
    const unit = SpectrumMediaService.unitOf(target, 'beta:', 0);
    let image;
    try {
      image = parseBetaMedia(data);
    } catch (e) {
      return fail(`Beta Disk error: ${(e as Error).message}`);
    }
    if (!image) return fail(`Not a recognised Beta Disk image: ${filename}`);
    s.stop();
    try {
      this.disks.insert(`beta:${unit}`, image, filename);
      return { ok: true, target: `beta:${unit}`, message: `Beta Disk ${unit === 0 ? 'A' : 'B'}: loaded: ${filename}` };
    } finally {
      s.start();
    }
  }

  private mountPlusD(data: Uint8Array, filename: string, target?: MediaTargetId): MountResult {
    const s = this.s;
    if (!s.mgtPlusD.enabled) return fail('Enable the MGT +D in Hardware first');
    const unit = SpectrumMediaService.unitOf(target, 'plusd:', 0);
    let image;
    try {
      image = parsePlusDMedia(data, filename);
    } catch (e) {
      return fail(`+D disk error: ${(e as Error).message}`);
    }
    if (!image) return fail(`Not a recognised +D image: ${filename}`);
    s.stop();
    try {
      this.disks.insert(`plusd:${unit}`, image, filename);
      return { ok: true, target: `plusd:${unit}`, message: `+D disk ${unit === 0 ? 'C' : 'D'}: loaded: ${filename}` };
    } finally {
      s.start();
    }
  }
}
