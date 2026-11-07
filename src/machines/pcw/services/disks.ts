/**
 * PCW DiskService — the 3" drives on the machine's uPD765A.
 *
 * The 8256 and 9512 have one drive; only the 8512 shipped with a second, so
 * `drives` is sized from the fitted count and the pane shows exactly what is there.
 */

import { baseName, saveHfeOr } from '@/machines/shared/disk-save.ts';
import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { readDskImage, writeDskImage } from '@/media/floppy/disk-state.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import type { PcwMachine } from '../pcw-machine.ts';

function unitOf(id: string): number { return id === 'b' ? 1 : 0; }

export class PcwDiskService implements DiskService {
  /** Mounted media names per drive id (media identity is service state). */
  private names = new Map<string, string>();

  constructor(private readonly m: PcwMachine) {}

  get drives(): readonly DriveDescriptor[] {
    const m = this.m;
    const motorUnit = m.fdc.motorOn ? m.fdc.currentUnit & 1 : -1;
    const out: DriveDescriptor[] = [];
    for (let u = 0; u < m.driveCount; u++) {
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
    if (unitOf(id) >= this.m.driveCount) throw new Error('that drive is not fitted');
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
    const out = saveHfeOr(image, base, '.dsk', serializeDSK);
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

  /** Snapshot: each fitted drive's disc, exactly as the FDC sees it, and the
   *  name it was mounted under. Write protect is a setting, not state; the
   *  flipped side and unsaved-writes flag travel with the FDC's state. */
  saveState(w: StateWriter): void {
    const count = this.m.driveCount;
    w.u8(count);
    for (let u = 0; u < count; u++) {
      const image = this.m.fdc.getDiskImage(u);
      w.bool(image !== null);
      if (image) {
        w.str(this.names.get(u === 0 ? 'a' : 'b') ?? '');
        writeDskImage(w, image);
      }
    }
  }

  /** Put the discs a snapshot carried in the drives, without booting (the
   *  machine's state is restored over it). Every disc is read before any
   *  drive changes. */
  loadState(r: StateReader): void {
    const count = r.u8();
    if (count !== this.m.driveCount) throw new Error('Snapshot drive count does not match this PCW');
    const discs: ({ name: string; image: DskImage } | null)[] = [];
    for (let u = 0; u < count; u++) discs.push(r.bool() ? { name: r.str(), image: readDskImage(r) } : null);
    discs.forEach((disc, u) => {
      const id = u === 0 ? 'a' : 'b';
      if (disc) {
        this.m.fdc.insertDisk(disc.image, u);
        this.names.set(id, disc.name);
      } else {
        this.m.fdc.ejectDisk(u);
        this.names.delete(id);
      }
    });
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
