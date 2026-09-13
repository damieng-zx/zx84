/**
 * PCW DiskService — the 3" drives on the machine's uPD765A.
 *
 * The 8256 and 9512 have one drive; only the 8512 shipped with a second, so
 * `drives` is sized from the config and the pane shows exactly what is fitted.
 */

import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { serializeHFE } from '@/media/floppy/hfe.ts';
import type { PcwMachine } from '../pcw-machine.ts';

function baseName(name: string, fallback: string): string {
  return name.replace(/\.[^.]+$/, '') || fallback;
}

function unitOf(id: string): number { return id === 'b' ? 1 : 0; }

export class PcwDiskService implements DiskService {
  /** Mounted media names per drive id (media identity is service state). */
  private names = new Map<string, string>();

  constructor(private readonly m: PcwMachine) {}

  get drives(): readonly DriveDescriptor[] {
    const m = this.m;
    const motorUnit = m.fdc.motorOn ? m.fdc.currentUnit & 1 : -1;
    const out: DriveDescriptor[] = [];
    for (let u = 0; u < m.config.drives; u++) {
      const id = u === 0 ? 'a' : 'b';
      out.push({
        id,
        label: u === 0 ? 'A:' : 'B:',
        loaded: m.fdc.getDiskImage(u) !== null,
        mediaName: this.names.get(id) ?? '',
        writeProtected: m.fdc.writeProtect[u],
        motorOn: motorUnit === u,
      });
    }
    return out;
  }

  insert(id: string, media: DriveMedia, name: string): void {
    this.m.loadDisk(media as DskImage, unitOf(id));
    this.names.set(id, name);
  }

  eject(id: string): void {
    this.m.fdc.ejectDisk(unitOf(id));
    this.names.delete(id);
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const unit = unitOf(id);
    const image = this.m.fdc.getDiskImage(unit);
    if (!image) return null;
    const base = baseName(this.names.get(id) ?? '', 'disk');
    // HFE-sourced discs save back as HFE so their bitstream survives; the rest
    // as DSK, which is how PCW software is distributed.
    const out = image.bitstream
      ? { data: serializeHFE(image), name: `${base}.hfe` }
      : { data: serializeDSK(image), name: `${base}.dsk` };
    this.m.fdc.clearDirty(unit);
    return out;
  }

  setWriteProtect(id: string, on: boolean): void {
    this.m.fdc.writeProtect[unitOf(id)] = on;
  }

  image(id: string): DskImage | null {
    return this.m.fdc.getDiskImage(unitOf(id));
  }

  setForceReady(id: string, on: boolean): void {
    this.m.fdc.forceReady[unitOf(id)] = on;
  }

  flipSide(id: string): number | null {
    const phys = unitOf(id);
    const image = this.m.fdc.getDiskImage(phys);
    if (!image?.flippy) return null;
    const newSide = this.m.fdc.flipSide[phys] ^ 1;
    this.m.fdc.flipSide[phys] = newSide;
    return newSide;
  }
}
