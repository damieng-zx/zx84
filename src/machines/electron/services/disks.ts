import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import { serializeAdfs } from '@/media/floppy/adfs.ts';
import { serializeSsd } from '@/media/floppy/ssd.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { ElectronMachine } from '../electron-machine.ts';

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'disk';
}

/** The Plus 3's two drives (0 and 1) on its WD1770. With no Plus 3 fitted there
 *  are no drives, so the Drives pane has nothing to show. */
export class ElectronDiskService implements DiskService {
  private readonly names = new Map<string, string>();

  constructor(private readonly machine: ElectronMachine) {}

  private unit(id: string): number { return id === 'b' ? 1 : 0; }

  get drives(): readonly DriveDescriptor[] {
    if (!this.machine.plus3Fitted) return [];
    return [this.describe('a', 'Drive 0', 0), this.describe('b', 'Drive 1', 1)];
  }

  insert(id: string, media: DriveMedia, name: string): void {
    this.machine.plus3.insertDisk(media as DskImage, this.unit(id));
    this.names.set(id, name);
  }

  eject(id: string): void {
    this.machine.plus3.ejectDisk(this.unit(id));
    this.names.delete(id);
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const plus3 = this.machine.plus3;
    const unit = this.unit(id);
    const image = plus3.getDiskImage(unit);
    if (!image) return null;
    const doubleSided = image.numSides === 2;
    const dfs = image.diskFormat === 'DFS';
    const data = dfs ? serializeSsd(image, doubleSided) : serializeAdfs(image);
    plus3.clearDirty(unit);
    const ext = dfs
      ? (doubleSided ? '.dsd' : '.ssd')
      : doubleSided ? '.adl' : image.numTracks > 40 ? '.adm' : '.ads';
    return { data, name: `${baseName(this.names.get(id) ?? '')}${ext}` };
  }

  setWriteProtect(id: string, on: boolean): void {
    this.machine.plus3.writeProtect[this.unit(id)] = on;
  }

  image(id: string): DskImage | null {
    return this.machine.plus3.getDiskImage(this.unit(id));
  }

  private describe(id: string, label: string, unit: number): DriveDescriptor {
    const plus3 = this.machine.plus3;
    return {
      id,
      label,
      loaded: plus3.getDiskImage(unit) !== null,
      mediaName: this.names.get(id) ?? '',
      writeProtected: plus3.writeProtect[unit],
      motorOn: plus3.motorOn && plus3.currentDrive === unit,
    };
  }
}
