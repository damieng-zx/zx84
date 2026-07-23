/**
 * Einstein DiskService — the two WD1772 drives ('a'/'b'). The Einstein reads
 * Extended CPC DSK images (and HFE/SCP flux) via the same neutral DskImage model.
 *
 * The optional Xtal-DOS disk is declared as a generic hidden boot-disk request;
 * the shell owns fetching/caching and this service owns DSK decoding.
 */

import type {
  BootDiskRequest, DiskService, DriveDescriptor, DriveMedia,
} from '@/machines/machine.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { parseFloppyImage, serializeHFE } from '@/media/floppy/hfe.ts';

const XTAL_DOS_BOOT_DISK: BootDiskRequest = {
  source: 'einstein/xtaldos.dsk',
  cacheKey: 'disk-einstein-xtaldos',
  parse: parseFloppyImage,
};

function baseName(name: string, fallback: string): string {
  return name.replace(/\.[^.]+$/, '') || fallback;
}

export class EinsteinDiskService implements DiskService {
  /** Mounted media names per drive id (media identity is service state). */
  private names = new Map<string, string>();

  constructor(private readonly e: EinsteinMachine) {}

  get bootDisk(): BootDiskRequest | null {
    return this.e.config.hasFDC && this.e.bootDiskEnabled ? XTAL_DOS_BOOT_DISK : null;
  }

  setBootDiskEnabled(on: boolean): void {
    this.e.bootDiskEnabled = on;
  }

  get drives(): readonly DriveDescriptor[] {
    const e = this.e;
    if (!e.config.hasFDC) return [];
    const motorUnit = e.fdc.motorOn ? e.fdc.currentUnit & 1 : -1;
    const out: DriveDescriptor[] = [];
    for (let u = 0; u < 2; u++) {
      const id = u === 0 ? 'a' : 'b';
      out.push({
        id,
        label: `Drive ${u}`,
        loaded: e.fdc.getDiskImage(u) !== null,
        mediaName: this.names.get(id) ?? '',
        writeProtected: e.fdc.writeProtect[u],
        motorOn: motorUnit === u,
      });
    }
    return out;
  }

  insert(id: string, media: DriveMedia, name: string): void {
    this.e.loadDisk(media as DskImage, id === 'a' ? 0 : 1);
    this.names.set(id, name);
  }

  eject(id: string): void {
    this.e.fdc.ejectDisk(id === 'a' ? 0 : 1);
    this.names.delete(id);
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const unit = id === 'a' ? 0 : 1;
    const image = this.e.fdc.getDiskImage(unit);
    if (!image) return null;
    const base = baseName(this.names.get(id) ?? '', 'disk');
    const out = image.bitstream
      ? { data: serializeHFE(image), name: `${base}.hfe` }
      : { data: serializeDSK(image), name: `${base}.dsk` };
    this.e.fdc.clearDirty(unit);
    return out;
  }

  setWriteProtect(id: string, on: boolean): void {
    this.e.fdc.writeProtect[id === 'a' ? 0 : 1] = on;
  }

  /** Live parsed image in a drive (drive-pane info signals), or null. */
  image(id: string): DskImage | null {
    return this.e.fdc.getDiskImage(id === 'a' ? 0 : 1);
  }

  /** Force the drive-ready line on regardless of media. */
  setForceReady(id: string, on: boolean): void {
    this.e.fdc.forceReady[id === 'a' ? 0 : 1] = on;
  }

  /** Flip a "flippy" double-sided image to its other side. */
  flipSide(id: string): number | null {
    const phys = (id === 'a' ? 0 : 1) & 1;
    const image = this.e.fdc.getDiskImage(phys);
    if (!image?.flippy) return null;
    const newSide = this.e.fdc.flipSide[phys] ^ 1;
    this.e.fdc.flipSide[phys] = newSide;
    return newSide;
  }

  /** Record a drive's mounted-media name without going through insert(). */
  noteName(id: string, name: string): void { this.names.set(id, name); }
}
