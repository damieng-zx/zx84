/**
 * EnterpriseDiskService — the EXDOS card's four drives (A: to D:).
 */

import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import { baseName } from '@/machines/shared/disk-save.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeFatImage } from '@/media/floppy/fat-image.ts';
import { readDskImage, writeDskImage } from '@/media/floppy/disk-state.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { hasRegularLayout } from '@/media/floppy/disk-detect.ts';
import { encodeHFE, serializeHFE } from '@/media/floppy/hfe.ts';
import type { EnterpriseMachine } from '../enterprise-machine.ts';

const UNIT_IDS = ['a', 'b', 'c', 'd'] as const;
const UNIT_LABELS = ['A:', 'B:', 'C:', 'D:'] as const;

export class EnterpriseDiskService implements DiskService {
  private readonly names = new Map<number, string>();

  /** After a refresh restore (a state without its disks): the disk each unit
   *  held, by name, which the shell is about to mount again. See
   *  {@link takeRemount}. */
  private pendingRemount = new Map<number, string>();

  constructor(private readonly m: EnterpriseMachine) {}

  /**
   * The drives for a snapshot: per unit whether a disk is in, its name and
   * write protect, and with `withImages` the disk itself. Write before the
   * card's state, so a restore mounts the disks before the WD1770 looks for
   * the sector it was in the middle of.
   */
  saveState(w: StateWriter, withImages: boolean): void {
    const fdc = this.m.exdos?.fdc ?? null;
    for (let u = 0; u < 4; u++) {
      const img = fdc?.getDiskImage(u) ?? null;
      w.bool(img !== null);
      w.str(this.names.get(u) ?? '');
      w.bool(fdc?.writeProtect[u] ?? false);
      if (img && withImages) writeDskImage(w, img);
    }
  }

  /** Read {@link saveState}. With the images, they replace what is in the
   *  drives; without, the drives are left alone and the names are kept for
   *  {@link takeRemount}. */
  loadState(r: StateReader, withImages: boolean): void {
    const fdc = this.m.exdos?.fdc ?? null;
    const units: { loaded: boolean; name: string; protect: boolean; image: DskImage | null }[] = [];
    for (let u = 0; u < 4; u++) {
      const loaded = r.bool(), name = r.str(), protect = r.bool();
      const image = loaded && withImages ? readDskImage(r) : null;
      units.push({ loaded, name, protect, image });
    }
    this.pendingRemount.clear();
    if (!fdc) return;
    units.forEach((e, u) => {
      if (!withImages) {
        if (e.loaded) this.pendingRemount.set(u, e.name);
        return;
      }
      if (e.image) { fdc.insertDisk(e.image, u); this.names.set(u, e.name); }
      else { fdc.ejectDisk(u); this.names.delete(u); }
      fdc.writeProtect[u] = e.protect;
    });
  }

  /**
   * True (and the disk goes in quietly, without the disk-change latch or the
   * restart a disk in A: normally brings) when this is the shell putting back
   * the disk a refresh-restored state was running with. Anything else ends
   * the wait for the remounts.
   */
  takeRemount(unit: number, image: DskImage, name: string): boolean {
    const card = this.m.exdos;
    const expected = this.pendingRemount.get(unit);
    if (!card || expected === undefined || expected !== name) {
      this.pendingRemount.clear();
      return false;
    }
    this.pendingRemount.delete(unit);
    card.fdc.insertDisk(image, unit);
    this.names.set(unit, name);
    return true;
  }

  /** Forget any remount a refresh restore was waiting for. */
  clearRemounts(): void { this.pendingRemount.clear(); }

  static unitOf(id: string): number {
    const i = (UNIT_IDS as readonly string[]).indexOf(id);
    if (i >= 0) return i;
    const unit = /^unit:(\d+)$/.exec(id);
    if (unit) return Math.min(3, Number(unit[1]));
    const n = Number(id);
    return Number.isInteger(n) && n >= 1 && n <= 4 ? n - 1 : 0;
  }

  get drives(): readonly DriveDescriptor[] {
    const card = this.m.exdos;
    if (!card) return [];
    const fdc = card.fdc;
    return UNIT_IDS.slice(0, this.m.driveCount).map((id, u) => ({
      id,
      label: UNIT_LABELS[u],
      loaded: fdc.getDiskImage(u) !== null,
      mediaName: this.names.get(u) ?? '',
      writeProtected: fdc.writeProtect[u],
      motorOn: fdc.motorOn && fdc.currentDrive === u,
    }));
  }

  insert(id: string, media: DriveMedia, name: string): void {
    const card = this.m.exdos;
    if (!card) return;
    const unit = EnterpriseDiskService.unitOf(id);
    if (unit >= this.m.driveCount) throw new Error('that drive is not fitted');
    card.fdc.insertDisk(media as DskImage, unit);
    card.noteDiskChanged(unit);
    this.names.set(unit, name);
  }

  eject(id: string): void {
    const card = this.m.exdos;
    if (!card) return;
    const unit = EnterpriseDiskService.unitOf(id);
    card.fdc.ejectDisk(unit);
    card.noteDiskChanged(unit);
    this.names.delete(unit);
  }

  image(id: string): DskImage | null {
    return this.m.exdos?.fdc.getDiskImage(EnterpriseDiskService.unitOf(id)) ?? null;
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const img = this.image(id);
    if (!img) return null;
    const unit = EnterpriseDiskService.unitOf(id);
    const stem = baseName(this.names.get(unit) ?? '', `enterprise-drive-${unit + 1}`);
    // An HFE keeps its bitstream (only written sectors re-encoded); a plain
    // 512-byte-sector layout saves as a raw .img; anything else (an odd layout
    // from a DSK, SCP or HFE) as a fresh .hfe, which loses nothing.
    if (img.bitstream) return { data: serializeHFE(img), name: `${stem}.hfe` };
    const spt = img.tracks[0]?.[0]?.sectors.length ?? 0;
    if (spt > 0 && hasRegularLayout(img, { sectors: spt, firstId: 1, size: 512, encoding: 'mfm' })) {
      return { data: serializeFatImage(img), name: `${stem}.img` };
    }
    return { data: encodeHFE(img), name: `${stem}.hfe` };
  }

  setWriteProtect(id: string, on: boolean): void {
    const card = this.m.exdos;
    if (card) card.fdc.writeProtect[EnterpriseDiskService.unitOf(id)] = on;
  }
}
