/**
 * CPC DiskService — the two internal uPD765A drives ('a'/'b') of a disk-capable
 * CPC (664/6128, or a 464 with an external DDI-1). Machines without a controller
 * simply present no drives (the pane hides).
 *
 * The service owns machine mutation only (insert/eject/serialize/WP); signal
 * updates and persistence remain shell reflection, exactly as before.
 */

import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { serializeHFE } from '@/media/floppy/hfe.ts';

function baseName(name: string, fallback: string): string {
  return name.replace(/\.[^.]+$/, '') || fallback;
}

export class CpcDiskService implements DiskService {
  /** Mounted media names per drive id (media identity is service state). */
  private names = new Map<string, string>();

  constructor(private readonly c: CpcMachine) {}

  get drives(): readonly DriveDescriptor[] {
    const c = this.c;
    if (!c.config.hasFDC) return [];
    const motorUnit = c.fdc.motorOn ? c.fdc.currentUnit & 1 : -1;
    const out: DriveDescriptor[] = [];
    for (let u = 0; u < 2; u++) {
      const id = u === 0 ? 'a' : 'b';
      out.push({
        id,
        label: u === 0 ? 'A:' : 'B:',
        loaded: c.fdc.getDiskImage(u) !== null,
        mediaName: this.names.get(id) ?? '',
        writeProtected: c.fdc.writeProtect[u],
        motorOn: motorUnit === u,
      });
    }
    return out;
  }

  insert(id: string, media: DriveMedia, name: string): void {
    this.c.loadDisk(media as DskImage, id === 'a' ? 0 : 1);
    this.names.set(id, name);
  }

  eject(id: string): void {
    this.c.fdc.ejectDisk(id === 'a' ? 0 : 1);
    this.names.delete(id);
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const unit = id === 'a' ? 0 : 1;
    const image = this.c.fdc.getDiskImage(unit);
    if (!image) return null;
    const base = baseName(this.names.get(id) ?? '', 'disk');
    // HFE-sourced disks save back as HFE (protection tracks preserved); the rest
    // as DSK.
    const out = image.bitstream
      ? { data: serializeHFE(image), name: `${base}.hfe` }
      : { data: serializeDSK(image), name: `${base}.dsk` };
    this.c.fdc.clearDirty(unit);
    return out;
  }

  setWriteProtect(id: string, on: boolean): void {
    this.c.fdc.writeProtect[id === 'a' ? 0 : 1] = on;
  }

  /** Record a drive's mounted-media name without going through insert() — used
   *  by shell paths that mutate the FDC directly (blank inserts). */
  noteName(id: string, name: string): void { this.names.set(id, name); }
}
