import { baseName } from '@/machines/shared/disk-save.ts';
import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import { serializeAcornDisc } from '@/media/floppy/acorn-disc.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { AcornSystemMachine } from '../machine.ts';

/**
 * The 8271 card's two drives. A System 3's card drives one or two 5.25" units;
 * the DOS numbers them 0 and 1, which the pane shows as A: and B:.
 */
export class AcornSystemDiskService implements DiskService {
  private readonly names = new Map<string, string>();

  constructor(private readonly machine: AcornSystemMachine) {}

  private unit(id: string): number { return id === 'b' ? 1 : 0; }

  get drives(): readonly DriveDescriptor[] {
    if (!this.machine.disk) return [];
    return [this.describe('a', 'Drive 0', 0), this.describe('b', 'Drive 1', 1)];
  }

  insert(id: string, media: DriveMedia, name: string): void {
    const disk = this.machine.disk;
    if (!disk) throw new Error('no disc controller is fitted');
    disk.insertDisk(media as DskImage, this.unit(id));
    this.names.set(id, name);
  }

  eject(id: string): void {
    this.machine.disk?.ejectDisk(this.unit(id));
    this.names.delete(id);
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const disk = this.machine.disk;
    if (!disk) return null;
    const unit = this.unit(id);
    const image = disk.getDiskImage(unit);
    if (!image) return null;
    // Ten 256-byte FM sectors per track saves as .ssd/.dsd; anything irregular
    // (an HFE-sourced or protected disc) keeps its sectors in a fresh .hfe.
    const { data, ext } = serializeAcornDisc(image);
    disk.clearDirty(unit);
    return { data, name: `${baseName(this.names.get(id) ?? '')}${ext}` };
  }

  setWriteProtect(id: string, on: boolean): void {
    const disk = this.machine.disk;
    if (disk) disk.writeProtect[this.unit(id)] = on;
  }

  image(id: string): DskImage | null {
    return this.machine.disk?.getDiskImage(this.unit(id)) ?? null;
  }

  private describe(id: string, label: string, unit: number): DriveDescriptor {
    const disk = this.machine.disk;
    return {
      id,
      label,
      loaded: disk !== null && disk.getDiskImage(unit) !== null,
      mediaName: this.names.get(id) ?? '',
      writeProtected: disk ? disk.writeProtect[unit] : false,
      motorOn: disk !== null && disk.motorOn && disk.currentDrive === unit,
    };
  }
}
