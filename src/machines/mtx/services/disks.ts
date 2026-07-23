import type {
  BootDiskRequest, DiskService, DriveDescriptor, DriveMedia,
} from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { parseMtxMfloppy, serializeMtxMfloppy } from '@/media/floppy/mtx-mfloppy.ts';
import type { MtxMachine } from '../mtx-machine.ts';

const CPM_SYSTEM_DISK: BootDiskRequest = {
  source: 'https://raw.githubusercontent.com/Memotech-Bill/MEMU/main/run_time/disks/andy_sys.mfloppy',
  cacheKey: 'disk-mtx-cpm-type07',
  parse: parseMtxMfloppy,
};

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'disk';
}

export class MtxDiskService implements DiskService {
  private readonly names = new Map<string, string>();

  constructor(private readonly machine: MtxMachine) {}

  get bootDisk(): BootDiskRequest | null {
    return this.machine.cpmSystemEnabled ? CPM_SYSTEM_DISK : null;
  }

  get drives(): readonly DriveDescriptor[] {
    return [
      this.describe('a', 'Drive B:', 0),
      this.describe('b', 'Drive C:', 1),
    ];
  }

  insert(id: string, media: DriveMedia, name: string): void {
    const unit = id === 'b' ? 1 : 0;
    this.machine.loadDisk(media as DskImage, unit);
    this.names.set(id, name);
  }

  eject(id: string): void {
    const unit = id === 'b' ? 1 : 0;
    this.machine.fdc.ejectDisk(unit);
    this.names.delete(id);
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const unit = id === 'b' ? 1 : 0;
    const image = this.machine.fdc.getDiskImage(unit);
    if (!image) return null;
    const result = {
      data: serializeMtxMfloppy(image),
      name: `${baseName(this.names.get(id) ?? '')}.mfloppy`,
    };
    this.machine.fdc.clearDirty(unit);
    return result;
  }

  setWriteProtect(id: string, on: boolean): void {
    this.machine.fdc.writeProtect[id === 'b' ? 1 : 0] = on;
  }

  image(id: string): DskImage | null {
    return this.machine.fdc.getDiskImage(id === 'b' ? 1 : 0);
  }

  private describe(id: string, label: string, unit: number): DriveDescriptor {
    const fdc = this.machine.fdc;
    return {
      id,
      label,
      loaded: fdc.getDiskImage(unit) !== null,
      mediaName: this.names.get(id) ?? '',
      writeProtected: fdc.writeProtect[unit],
      motorOn: this.machine.fdx.motorOn && fdc.currentDrive === unit,
    };
  }
}
