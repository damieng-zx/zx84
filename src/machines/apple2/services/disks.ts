import { baseName } from '@/machines/shared/disk-save.ts';
import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { parseApple2Media, serializeApple2Media } from '@/media/floppy/apple2-media.ts';
import type { Apple2Machine } from '../apple2-machine.ts';

/** The Disk II's two drives (A: = drive 1). */
export class Apple2DiskService implements DiskService {
  private readonly names = new Map<string, string>();

  constructor(private readonly machine: Apple2Machine) {}

  private unit(id: string): number { return id === 'b' ? 1 : 0; }

  /** The drives on the controller; none at all when the card is not fitted. */
  get drives(): readonly DriveDescriptor[] {
    const { disk2, drives } = this.machine.options;
    if (!disk2) return [];
    const all = [this.describe('a', 'Drive 1', 0), this.describe('b', 'Drive 2', 1)];
    return all.slice(0, drives);
  }

  /** Insert a disk: an Apple II disk as mounted before (carried across a
   *  rebuild, with its bit tracks), or a plain sector image to nibblize. */
  insert(id: string, media: DriveMedia, name: string): void {
    this.machine.disk2.insertDisk(media as DskImage, this.unit(id));
    this.names.set(id, name);
  }

  eject(id: string): void {
    this.machine.disk2.ejectDisk(this.unit(id));
    this.names.delete(id);
  }

  /** The disk in the format it was loaded as (.dsk/.po, .d13, .nib, .2mg or
   *  .woz), with everything written to it. */
  save(id: string): { data: Uint8Array; name: string } | null {
    const unit = this.unit(id);
    const disk = this.machine.disk2.getDiskImage(unit);
    if (!disk) return null;
    this.machine.disk2.flushWrites(unit);
    const { data, ext } = serializeApple2Media(disk);
    this.machine.disk2.clearDirty(unit);
    return { data, name: `${baseName(this.names.get(id) ?? '')}${ext}` };
  }

  setWriteProtect(id: string, on: boolean): void {
    this.machine.disk2.setWriteProtect(this.unit(id), on);
  }

  image(id: string): DskImage | null {
    return this.machine.disk2.getDiskImage(this.unit(id));
  }

  /** Load a disk image file into a drive (used by the media service). */
  mountImage(id: string, data: Uint8Array, name: string): void {
    if (!this.machine.options.disk2) throw new Error('no Disk II controller is fitted');
    if (!this.drives.some(drive => drive.id === id)) throw new Error('that drive is not fitted');
    this.insert(id, parseApple2Media(data, name), name);
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
