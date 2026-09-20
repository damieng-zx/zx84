import type {
  BootDiskRequest, DiskService, DriveDescriptor, DriveMedia,
} from '@/machines/machine.ts';
import { parseFloppyImage, serializeHFE } from '@/media/floppy/hfe.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeMtxMfloppy } from '@/media/floppy/mtx-mfloppy.ts';
import type { MtxMachine } from '../mtx-machine.ts';

const CPM_STARTUP_OFFSET = 0x10;
const CPM_STARTUP_END = 0x40;
const DEFAULT_STARTUP = 'CONFIG B:07\r';
const RAM_DISK_STARTUP = 'CONFIG B:07\rSIDISC\rCONFIG F:43\r';

const CPM_SYSTEM_DISK = {
  source: 'https://zx84files.bitsparse.com/media/memotech/Dave07Sys.hfe',
  cacheKey: 'disk-mtx-cpm-dave07',
};

function writeStartup(target: Uint8Array, ramDisk: boolean): void {
  target.fill(0, CPM_STARTUP_OFFSET, CPM_STARTUP_END);
  const command = ramDisk ? RAM_DISK_STARTUP : DEFAULT_STARTUP;
  for (let i = 0; i < command.length; i++) {
    target[CPM_STARTUP_OFFSET + i] = command.charCodeAt(i);
  }
}

export function parseMtxCpmSystemDisk(data: Uint8Array, ramDisk: boolean): DskImage {
  // The system disk is an HFE bitstream, so its boot-sector startup command is
  // patched in the decoded sector — the same place the RAM-disk toggle writes —
  // rather than in the raw file bytes.
  const image = parseFloppyImage(data);
  const boot = image.tracks[0]?.[0]?.sectors[0]?.data;
  if (boot) writeStartup(boot, ramDisk);
  return image;
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'disk';
}

export class MtxDiskService implements DiskService {
  private readonly names = new Map<string, string>();

  constructor(private readonly machine: MtxMachine) {}

  get bootDisk(): BootDiskRequest | null {
    if (!this.machine.cpmSystemEnabled) return null;
    return {
      ...CPM_SYSTEM_DISK,
      parse: data => parseMtxCpmSystemDisk(
        data,
        this.machine.memory.ramExpansion512kEnabled,
      ),
    };
  }

  get drives(): readonly DriveDescriptor[] {
    if (!this.machine.floppyEnabled) return [];
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
    const extension = image.bitstream ? '.hfe' : image.numTracks === 40 ? '.mfloppy-03' : '.mfloppy';
    const result = {
      data: image.bitstream ? serializeHFE(image) : serializeMtxMfloppy(image),
      name: `${baseName(this.names.get(id) ?? '')}${extension}`,
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

  configureCpmRamDiskStartup(enabled: boolean): void {
    if (this.names.get('a') !== '') return;
    const image = this.machine.fdc.getDiskImage(0);
    const firstSector = image?.tracks[0]?.[0]?.sectors[0]?.data;
    if (firstSector) writeStartup(firstSector, enabled);
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
