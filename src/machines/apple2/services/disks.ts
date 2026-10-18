import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import {
  detectApple2DiskOrder, parseApple2Disk, serializeApple2Disk, type Apple2DiskOrder,
} from '@/media/floppy/apple2.ts';
import type { Apple2Machine } from '../apple2-machine.ts';

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'disk';
}

/** The Disk II's two drives (A: = drive 1). */
export class Apple2DiskService implements DiskService {
  private readonly names = new Map<string, string>();
  private readonly order = new Map<string, Apple2DiskOrder>();

  constructor(private readonly machine: Apple2Machine) {}

  private unit(id: string): number { return id === 'b' ? 1 : 0; }

  /** The drives on the controller; none at all when the card is not fitted. */
  get drives(): readonly DriveDescriptor[] {
    const { disk2, drives } = this.machine.options;
    if (!disk2) return [];
    const all = [this.describe('a', 'Drive 1', 0), this.describe('b', 'Drive 2', 1)];
    return all.slice(0, drives);
  }

  insert(id: string, media: DriveMedia, name: string): void {
    this.machine.disk2.insertDisk(media as DskImage, this.unit(id));
    this.names.set(id, name);
    this.order.set(id, /\.po$/i.test(name) ? 'prodos' : 'dos');
  }

  eject(id: string): void {
    this.machine.disk2.ejectDisk(this.unit(id));
    this.names.delete(id);
    this.order.delete(id);
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const image = this.image(id);
    if (!image) return null;
    const order = this.order.get(id) ?? 'dos';
    const data = serializeApple2Disk(image, order);
    this.machine.disk2.clearDirty(this.unit(id));
    return { data, name: `${baseName(this.names.get(id) ?? '')}${order === 'prodos' ? '.po' : '.dsk'}` };
  }

  setWriteProtect(id: string, on: boolean): void {
    this.machine.disk2.writeProtect[this.unit(id)] = on;
  }

  image(id: string): DskImage | null {
    return this.machine.disk2.getDiskImage(this.unit(id));
  }

  /** Load a raw sector image into a drive (used by the media service). */
  mountImage(id: string, data: Uint8Array, name: string): void {
    if (!this.machine.options.disk2) throw new Error('no Disk II controller is fitted');
    if (!this.drives.some(drive => drive.id === id)) throw new Error('that drive is not fitted');
    const order = detectApple2DiskOrder(data, name);
    this.insert(id, parseApple2Disk(data, order), name);
    this.order.set(id, order);     // insert() only knows the name; this saw the bytes
  }

  private describe(id: string, label: string, unit: number): DriveDescriptor {
    const image = this.machine.disk2.getDiskImage(unit);
    return {
      id,
      label,
      loaded: image !== null,
      mediaName: this.names.get(id) ?? '',
      writeProtected: this.machine.disk2.writeProtect[unit],
      motorOn: this.machine.disk2.motorOn && this.machine.disk2.currentDriveIndex === unit,
    };
  }
}
