/**
 * EnterpriseDiskService — the EXDOS card's four drives (A: to D:).
 */

import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeFatImage } from '@/media/floppy/fat-image.ts';
import type { EnterpriseMachine } from '../enterprise-machine.ts';

const UNIT_IDS = ['a', 'b', 'c', 'd'] as const;
const UNIT_LABELS = ['A:', 'B:', 'C:', 'D:'] as const;

export class EnterpriseDiskService implements DiskService {
  private readonly names = new Map<number, string>();

  constructor(private readonly m: EnterpriseMachine) {}

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
    return UNIT_IDS.map((id, u) => ({
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
    const stem = (this.names.get(unit) ?? '').replace(/\.[^.]+$/, '') || `enterprise-drive-${unit + 1}`;
    return { data: serializeFatImage(img), name: `${stem}.img` };
  }

  setWriteProtect(id: string, on: boolean): void {
    const card = this.m.exdos;
    if (card) card.fdc.writeProtect[EnterpriseDiskService.unitOf(id)] = on;
  }
}
