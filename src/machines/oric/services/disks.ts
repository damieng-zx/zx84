/**
 * OricDiskService — the Microdisc's four drives.
 *
 * The WD1793 addresses units 0-3 as drives A: to D:, and the card's latch
 * selects one at a time. Media identity is service state (the controller holds
 * only the parsed image), exactly as the other machines' disk services do.
 *
 * The Microdisc is a fitted add-on, so the service exists only while the
 * Hardware pane has one: with no card the array is empty and the Drives pane
 * stays hidden.
 */

import { baseName } from '@/machines/shared/disk-save.ts';
import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { readDskImage, writeDskImage } from '@/media/floppy/disk-state.ts';
import { serializeOricDsk } from '@/media/floppy/oric-dsk.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import type { OricMachine } from '../oric-machine.ts';

/** Drive ids in controller order. */
const UNIT_IDS = ['a', 'b', 'c', 'd'] as const;
const UNIT_LABELS = ['A:', 'B:', 'C:', 'D:'] as const;

export class OricDiskService implements DiskService {
  /** Mounted media name per unit. */
  private readonly names = new Map<number, string>();

  constructor(private readonly machine: OricMachine) {}

  /** A drive id to its unit: 'a'/'1' → 0 … 'd'/'4' → 3. */
  private static unitOf(id: string): number {
    const i = (UNIT_IDS as readonly string[]).indexOf(id);
    if (i >= 0) return i;
    const n = Number(id);
    return Number.isInteger(n) && n >= 1 && n <= 4 ? n - 1 : 0;
  }

  get drives(): readonly DriveDescriptor[] {
    const card = this.machine.microdisc;
    if (!card) return [];
    const out: DriveDescriptor[] = [];
    for (let unit = 0; unit < UNIT_IDS.length; unit++) {
      out.push({
        id: UNIT_IDS[unit],
        label: UNIT_LABELS[unit],
        loaded: card.fdc.getDiskImage(unit) !== null,
        mediaName: this.names.get(unit) ?? '',
        writeProtected: card.fdc.writeProtect[unit],
        // The card selects one drive at a time and drives its motor itself.
        motorOn: card.fdc.motorOn && card.drive === unit,
      });
    }
    return out;
  }

  insert(id: string, media: DriveMedia, name: string): void {
    const card = this.machine.microdisc;
    if (!card) throw new Error('no Microdisc is fitted');
    const unit = OricDiskService.unitOf(id);
    card.fdc.insertDisk(media as DskImage, unit);
    this.names.set(unit, name);
  }

  eject(id: string): void {
    const card = this.machine.microdisc;
    if (!card) return;
    const unit = OricDiskService.unitOf(id);
    card.fdc.ejectDisk(unit);
    this.names.delete(unit);
  }

  image(id: string): DskImage | null {
    return this.machine.microdisc?.fdc.getDiskImage(OricDiskService.unitOf(id)) ?? null;
  }

  /** Saved as an `ORICDISK` container, which needs no cell re-encoding. */
  save(id: string): { data: Uint8Array; name: string } | null {
    const img = this.image(id);
    if (!img) return null;
    const unit = OricDiskService.unitOf(id);
    const stem = baseName(this.names.get(unit) ?? '', `oric-drive-${unit + 1}`);
    return { data: serializeOricDsk(img), name: `${stem}.dsk` };
  }

  setWriteProtect(id: string, on: boolean): void {
    const card = this.machine.microdisc;
    if (!card) return;
    card.fdc.writeProtect[OricDiskService.unitOf(id)] = on;
  }

  /** The four drives' disks, names and write-protect tabs, for a snapshot. */
  saveState(w: StateWriter): void {
    const card = this.machine.microdisc;
    if (!card) return;
    w.u8(UNIT_IDS.length);
    for (let unit = 0; unit < UNIT_IDS.length; unit++) {
      const img = card.fdc.getDiskImage(unit);
      w.bool(img !== null);
      if (img) { writeDskImage(w, img); w.str(this.names.get(unit) ?? ''); }
      w.bool(card.fdc.writeProtect[unit]);
    }
  }

  loadState(r: StateReader): void {
    const card = this.machine.microdisc;
    if (!card) return;
    const n = r.u8();
    if (n !== UNIT_IDS.length) throw new Error('Snapshot is corrupt (drive count)');
    const drives: { img: DskImage | null; name: string; protect: boolean }[] = [];
    for (let unit = 0; unit < n; unit++) {
      const img = r.bool() ? readDskImage(r) : null;
      const name = img ? r.str() : '';
      drives.push({ img, name, protect: r.bool() });
    }
    drives.forEach((d, unit) => {
      if (d.img) { card.fdc.insertDisk(d.img, unit); this.names.set(unit, d.name); }
      else { card.fdc.ejectDisk(unit); this.names.delete(unit); }
      card.fdc.writeProtect[unit] = d.protect;
    });
  }
}
