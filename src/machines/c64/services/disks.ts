/**
 * C64DiskService — the 1541 as the Drives pane sees it: one drive, device 8,
 * which takes `.d64` and `.g64` disks and gives them back in the format they
 * came in (a `.g64` when a `.d64` could no longer hold what is on the disk).
 */

import { baseName } from '@/machines/shared/disk-save.ts';
import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import {
  c64DiskImage, isC64DiskImage, parseC64Disk, serializeC64Disk, type C64Disk,
} from '@/media/floppy/c64-disk.ts';
import type { C64Machine } from '../c64-machine.ts';

export class C64DiskService implements DiskService {
  constructor(private readonly m: C64Machine) {}

  /** The drive on the bus, or none while the Hardware pane has it unplugged. */
  get drives(): readonly DriveDescriptor[] {
    const drive = this.m.drive;
    if (!drive) return [];
    return [{
      id: 'a',
      label: 'Drive 8',
      loaded: drive.disk !== null,
      mediaName: drive.mediaName,
      writeProtected: drive.writeProtected,
      motorOn: drive.motorOn,
    }];
  }

  private diskOf(media: DriveMedia): C64Disk {
    if (isC64DiskImage(media)) return media.c64;
    if (media instanceof Uint8Array) return parseC64Disk(media);
    throw new Error('not a Commodore 1541 disk');
  }

  insert(id: string, media: DriveMedia, name: string): void {
    const drive = this.m.drive;
    if (!drive || id !== 'a') throw new Error('that drive is not fitted');
    drive.insertDisk(this.diskOf(media), drive.writeProtected, name);
  }

  eject(id: string): void {
    if (id === 'a') this.m.drive?.ejectDisk();
  }

  /** The disk as it is now, writes included. */
  save(id: string): { data: Uint8Array; name: string } | null {
    const drive = this.m.drive;
    if (!drive?.disk || id !== 'a') return null;
    const { data, ext } = serializeC64Disk(drive.disk);
    drive.dirty = false;
    return { data, name: `${baseName(drive.mediaName)}${ext}` };
  }

  setWriteProtect(id: string, on: boolean): void {
    if (id === 'a') this.m.drive?.setWriteProtect(on);
  }

  image(id: string): DskImage | null {
    const disk = id === 'a' ? this.m.drive?.disk : null;
    return disk ? c64DiskImage(disk) : null;
  }

  /** Load a disk file into the drive (used by the media service). `reattach`
   *  puts back the disk a restored snapshot already had, without the sensor
   *  flickering as if the disk had been changed. */
  mountImage(id: string, data: Uint8Array, name: string, reattach = false): void {
    const drive = this.m.drive;
    if (!drive || id !== 'a') throw new Error('the 1541 disk drive is not fitted (see the Hardware pane)');
    drive.insertDisk(parseC64Disk(data), drive.writeProtected, name, reattach);
  }
}
