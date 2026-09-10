/**
 * LynxDiskService — the two internal drives behind the FD1793.
 *
 * Only the 96K and 128K carry the interface (the 48K has `hasDisk` false, and
 * its media service never routes a disk here). Media identity — the mounted
 * filename — is service state; the controller holds only the parsed image.
 */

import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeLdf } from '@/media/floppy/ldf-image.ts';
import type { LynxMachine } from '../lynx-machine.ts';

function baseName(name: string, fallback: string): string {
  return name.replace(/\.[^.]+$/, '') || fallback;
}

export class LynxDiskService implements DiskService {
  /** Mounted media name per drive unit, not per id spelling. */
  private readonly names = new Map<number, string>();

  constructor(private readonly m: LynxMachine) {}

  /** The built-in drives are 'a' and 'b' to every generic consumer. */
  private static unitOf(id: string): number {
    return id === 'b' || id === '2' ? 1 : 0;
  }

  get drives(): readonly DriveDescriptor[] {
    const fdc = this.m.fdc;
    const out: DriveDescriptor[] = [];
    for (let u = 0; u < 2; u++) {
      const id = u === 0 ? 'a' : 'b';
      out.push({
        id,
        label: `Drive ${u + 1}:`,
        loaded: fdc.getDiskImage(u) !== null,
        mediaName: this.names.get(u) ?? '',
        writeProtected: fdc.writeProtect[u],
        motorOn: fdc.motorOn && fdc.currentDrive === u,
      });
    }
    return out;
  }

  insert(id: string, media: DriveMedia, name: string): void {
    const unit = LynxDiskService.unitOf(id);
    this.m.fdc.insertDisk(media as DskImage, unit);
    this.names.set(unit, name);
  }

  eject(id: string): void {
    const unit = LynxDiskService.unitOf(id);
    this.m.fdc.ejectDisk(unit);
    this.names.delete(unit);
  }

  image(id: string): DskImage | null {
    return this.m.fdc.getDiskImage(LynxDiskService.unitOf(id));
  }

  /** The Lynx's own format is the headerless `.ldf` raw sector dump. */
  save(id: string): { data: Uint8Array; name: string } | null {
    const img = this.image(id);
    if (!img) return null;
    const unit = LynxDiskService.unitOf(id);
    const stem = baseName(this.names.get(unit) ?? '', `lynx-drive-${unit + 1}`);
    return { data: serializeLdf(img), name: `${stem}.ldf` };
  }

  setWriteProtect(id: string, on: boolean): void {
    this.m.fdc.writeProtect[LynxDiskService.unitOf(id)] = on;
  }
}
