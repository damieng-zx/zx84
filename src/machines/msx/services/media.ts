/**
 * MSX MediaService — the machine's own file routing: `.rom` cartridges
 * (auto-booted), `.cas` cassettes (BIOS-trap load) and, while the optional
 * floppy disk interface is fitted, disk images for drives A: and B:. ZIP
 * unwrapping stays a shell concern.
 *
 * The service mutates the machine only. The cartridge name / cassette block /
 * disk signals, persistence and machine restart stay shell reflection, keyed
 * off MountResult.target.
 */

import type { MediaService, MediaTypeDescriptor, MediaTargetId, MountResult } from '@/machines/machine.ts';
import { parseMsxFloppy } from '@/media/floppy/msx-disk.ts';
import type { MsxDiskService } from './disks.ts';
import type { MsxRomService } from './roms.ts';
import type { MsxTapeService } from './tape.ts';

function fail(message: string): MountResult { return { ok: false, message }; }

/** Disk container extensions the floppy interface accepts. `.dsk`/`.img` are
 *  raw sector dumps; `.edsk` is the extended CPC container used for disks that
 *  a plain dump cannot hold. */
const DISK_EXTENSIONS = ['.dsk', '.img', '.dmk', '.hfe', '.scp', '.td0', '.edsk'] as const;
const DISK_PATTERN = /\.(?:dsk|img|dmk|hfe|scp|td0|edsk)$/i;

export class MsxMediaService implements MediaService {
  constructor(
    private readonly roms: MsxRomService,
    private readonly tape: MsxTapeService,
    private readonly disks: MsxDiskService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    const types: MediaTypeDescriptor[] = [
      { ext: '.rom', target: 'cartridge' },
      { ext: '.cas', target: 'tape' },
    ];
    if (this.disks.drives.length > 0) {
      for (const ext of DISK_EXTENSIONS) types.push({ ext, target: 'a' });
    }
    return types;
  }

  async mount(data: Uint8Array, filename: string, target?: MediaTargetId): Promise<MountResult> {
    // Cartridge ROM: insert into slot 1 and power-cycle so the BIOS scan runs it.
    if (/\.rom$/i.test(filename)) {
      this.roms.cartridge.insert(data, filename);
      return { ok: true, target: 'cartridge', message: `Cartridge: ${filename}` };
    }

    // Cassette: mount the .cas; the BIOS TAPION/TAPIN traps serve it on CLOAD/BLOAD.
    if (/\.cas$/i.test(filename)) {
      this.tape.mount(data, filename);
      return { ok: true, target: 'cas', message: `Cassette: ${filename} — type CLOAD or BLOAD"CAS:"` };
    }

    if (DISK_PATTERN.test(filename)) {
      if (this.disks.drives.length === 0) {
        return fail('Fit the disk interface in the Hardware pane to use disk images');
      }
      const id = target === 'b' || target === 'unit:1' ? 'b' : 'a';
      try {
        this.disks.insert(id, parseMsxFloppy(data), filename);
      } catch (err) {
        return fail(`Disk error: ${(err as Error).message}`);
      }
      return { ok: true, target: id, message: `Drive ${id.toUpperCase()}: loaded: ${filename}` };
    }

    return fail('MSX accepts .rom cartridges, .cas cassettes and disk images (.dsk .img .dmk .hfe .scp .td0 .edsk), or a .zip of one');
  }
}
