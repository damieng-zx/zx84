import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import { serializeSsd } from '@/media/floppy/ssd.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { BbcMachine } from '../bbc-machine.ts';

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'disk';
}

/** The two physical DFS drives (0 and 1) backed by whichever disc controller
 *  (8271 or 1770) the machine has fitted. */
export class BbcDiskService implements DiskService {
  private readonly names = new Map<string, string>();

  constructor(private readonly machine: BbcMachine) {}

  private unit(id: string): number { return id === 'b' ? 1 : 0; }

  get drives(): readonly DriveDescriptor[] {
    if (!this.machine.disc) return [];
    return [this.describe('a', 'Drive 0', 0), this.describe('b', 'Drive 1', 1)];
  }

  insert(id: string, media: DriveMedia, name: string): void {
    this.machine.disc?.insertDisk(media as DskImage, this.unit(id));
    this.names.set(id, name);
  }

  eject(id: string): void {
    this.machine.disc?.ejectDisk(this.unit(id));
    this.names.delete(id);
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const disc = this.machine.disc;
    if (!disc) return null;
    const unit = this.unit(id);
    const image = disc.getDiskImage(unit);
    if (!image) return null;
    const doubleSided = image.numSides === 2;
    const data = serializeSsd(image, doubleSided);
    disc.clearDirty(unit);
    return {
      data,
      name: `${baseName(this.names.get(id) ?? '')}${doubleSided ? '.dsd' : '.ssd'}`,
    };
  }

  setWriteProtect(id: string, on: boolean): void {
    const disc = this.machine.disc;
    if (disc) disc.writeProtect[this.unit(id)] = on;
  }

  image(id: string): DskImage | null {
    return this.machine.disc?.getDiskImage(this.unit(id)) ?? null;
  }

  private describe(id: string, label: string, unit: number): DriveDescriptor {
    const disc = this.machine.disc;
    return {
      id,
      label,
      loaded: disc !== null && disc.getDiskImage(unit) !== null,
      mediaName: this.names.get(id) ?? '',
      writeProtected: disc ? disc.writeProtect[unit] : false,
      motorOn: disc !== null && disc.motorOn && disc.currentDrive === unit,
    };
  }
}
