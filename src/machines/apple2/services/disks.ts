import { baseName } from '@/machines/shared/disk-save.ts';
import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { parseApple2Media, serializeApple2Media, type Apple2Disk } from '@/media/floppy/apple2-media.ts';
import { readApple2Disk, writeApple2Disk } from '@/media/floppy/apple2-disk-state.ts';
import type { Apple2Machine } from '../apple2-machine.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

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

  // ── Snapshot ─────────────────────────────────────────────────────────────

  /** Put a disk back in a drive without disturbing the controller (the head
   *  positions, where each disk is under its head): the refresh-resume remount. */
  reattachImage(id: string, data: Uint8Array, name: string): void {
    const disk2 = this.machine.disk2;
    const w = new StateWriter();
    disk2.saveState(w);
    this.mountImage(id, data, name);
    disk2.loadState(new StateReader(w.finish()));
  }

  /** Write both drives' disks as they are now (a guest's writes included):
   *  bit tracks and sector view, how to save them back, name and
   *  write-protect switch. */
  saveState(w: StateWriter): void {
    const disk2 = this.machine.disk2;
    for (let unit = 0; unit < 2; unit++) {
      const disk = disk2.getDiskImage(unit);
      w.bool(disk !== null);
      if (!disk) continue;
      w.str(this.names.get(unit === 0 ? 'a' : 'b') ?? '');
      w.bool(disk2.writeProtect[unit]);
      writeApple2Disk(w, disk);
    }
  }

  /** Put the saved disks in the drives (an empty one is emptied). Reads
   *  everything before it changes a drive; the controller's own state is
   *  restored afterwards. */
  loadState(r: StateReader): void {
    const drives: ({ name: string; protect: boolean; disk: Apple2Disk } | null)[] = [];
    for (let unit = 0; unit < 2; unit++) {
      if (!r.bool()) { drives.push(null); continue; }
      const name = r.str();
      const protect = r.bool();
      drives.push({ name, protect, disk: readApple2Disk(r) });
    }
    const disk2 = this.machine.disk2;
    drives.forEach((d, unit) => {
      const id = unit === 0 ? 'a' : 'b';
      if (!d) {
        disk2.ejectDisk(unit);
        this.names.delete(id);
        return;
      }
      disk2.insertDisk(d.disk, unit);
      disk2.writeProtect[unit] = d.protect;
      this.names.set(id, d.name);
    });
  }
}
