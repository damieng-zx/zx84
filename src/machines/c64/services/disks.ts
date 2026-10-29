/**
 * C64DiskService — the disk drives as the Drives pane sees them: up to four,
 * devices 8 to 11 (ids a to d), each a 1541 (`.d64` and `.g64` disks, given
 * back in the format they came in) or a 1581 (`.d81`). The Drives pane's
 * "..." menu adds and removes drives and picks each one's model. A drive of a
 * model already fitted copies that drive's DOS ROM, so adding it is instant;
 * a model not yet fitted needs its ROM, so the machine is rebuilt to fetch it.
 */

import { baseName } from '@/machines/shared/disk-save.ts';
import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { C64Machine } from '../c64-machine.ts';
import { C64_MAX_DRIVES, isC64DriveModel } from '../drive/drive-unit.ts';

export const C64_DRIVE_IDS = 'abcd';

export class C64DiskService implements DiskService {
  constructor(private readonly m: C64Machine) {}

  /** A drive's place on the bus from its pane id, or -1. */
  private indexOf(id: string): number {
    const i = C64_DRIVE_IDS.indexOf(id);
    return i >= 0 && i < this.m.drives.length ? i : -1;
  }

  /** The drives on the bus, or none while the Hardware pane has them unplugged. */
  get drives(): readonly DriveDescriptor[] {
    return this.m.drives.map((drive, i) => ({
      id: C64_DRIVE_IDS[i],
      label: `Drive ${8 + i}`,
      loaded: drive.loaded,
      mediaName: drive.mediaName,
      writeProtected: drive.writeProtected,
      motorOn: drive.motorOn,
    }));
  }

  /** The models the pane has set up, one per drive. */
  get driveModels(): readonly string[] { return this.m.driveModels; }

  /** Switch a drive to another model. Its disk cannot go with it (a 1541
   *  reads GCR, a 1581 MFM), so it comes out. A model fitted elsewhere lends
   *  its ROM; otherwise the machine is rebuilt, after the pane has saved the
   *  choice, to fetch the DOS ROM. */
  setDriveModel(index: number, model: string): void | Promise<void> {
    const m = this.m;
    if (!isC64DriveModel(model) || index < 0 || index >= m.driveModels.length || m.driveModels[index] === model) return;
    if (m.drives.length > 0 && m.replaceDriveAt(index, model)) return;
    const models = [...m.driveModels];
    models[index] = model;
    m.driveModels = models;
    m.drives[index]?.ejectDisk();
    const roms = m.host?.roms;
    if (!roms) return;
    return new Promise(resolve => queueMicrotask(() => { roms.rebuild().then(resolve, resolve); }));
  }

  /** Add an empty drive below `after`, of the same model; the drives under it
   *  move down a device number. False at the limit. */
  addDrive(after: number): boolean {
    const m = this.m;
    if (m.driveModels.length >= C64_MAX_DRIVES) return false;
    const at = Math.min(Math.max(after, -1), m.driveModels.length - 1) + 1;
    const model = m.driveModels[at - 1] ?? m.driveModels[0] ?? '1541';
    if (m.drives.length === 0) {
      m.driveModels = [...m.driveModels.slice(0, at), model, ...m.driveModels.slice(at)];
      return true;
    }
    return m.insertDriveAt(at, model);
  }

  /** Remove a drive and its disk; the drives under it move up. The last drive
   *  stays (the Hardware pane unplugs them all). */
  removeDrive(index: number): boolean {
    const m = this.m;
    if (m.driveModels.length <= 1 || index < 0 || index >= m.driveModels.length) return false;
    if (m.drives.length === 0) {
      m.driveModels = m.driveModels.filter((_, i) => i !== index);
      return true;
    }
    return m.removeDriveAt(index);
  }

  insert(id: string, media: DriveMedia, name: string): void {
    const drive = this.m.drives[this.indexOf(id)];
    if (!drive) throw new Error('that drive is not fitted');
    if (media instanceof Uint8Array) drive.mountImage(media, name);
    else drive.insertImage(media as DskImage, name);
  }

  eject(id: string): void {
    this.m.drives[this.indexOf(id)]?.ejectDisk();
  }

  /** The disk as it is now, writes included. */
  save(id: string): { data: Uint8Array; name: string } | null {
    const drive = this.m.drives[this.indexOf(id)];
    if (!drive?.loaded) return null;
    const saved = drive.saveImage();
    return saved ? { data: saved.data, name: `${baseName(drive.mediaName)}${saved.ext}` } : null;
  }

  setWriteProtect(id: string, on: boolean): void {
    this.m.drives[this.indexOf(id)]?.setWriteProtect(on);
  }

  image(id: string): DskImage | null {
    return this.m.drives[this.indexOf(id)]?.diskImage() ?? null;
  }

  /** Load a disk file into a drive (used by the media service). `reattach`
   *  puts back the disk a restored snapshot already had, without the drive
   *  noticing a change. */
  mountImage(id: string, data: Uint8Array, name: string, reattach = false): void {
    const drive = this.m.drives[this.indexOf(id)];
    if (!drive) throw new Error('the disk drive is not fitted (see the Hardware pane and the Drives pane)');
    drive.mountImage(data, name, reattach);
  }
}
