/**
 * MSX DiskService — the two drives ('a'/'b') behind the optional floppy disk
 * interface. Drives only exist while the interface is fitted with its ROM; with
 * no card in slot 3 the list is empty and the Drives pane hides itself.
 */

import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { serializeHFE } from '@/media/floppy/hfe.ts';
import { isRegularMsxImage, serializeMsxRaw } from '@/media/floppy/msx-disk.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';

function unitOf(id: string): number { return id === 'b' ? 1 : 0; }

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'disk';
}

export class MsxDiskService implements DiskService {
  private readonly names = new Map<string, string>();

  constructor(private readonly m: MsxMachine) {}

  get drives(): readonly DriveDescriptor[] {
    const m = this.m;
    if (!m.floppyEnabled || !m.diskIf.romLoaded) return [];
    const active = m.diskIf.selectedDrive;
    return [0, 1].map((u): DriveDescriptor => ({
      id: u === 0 ? 'a' : 'b',
      label: u === 0 ? 'A:' : 'B:',
      loaded: m.fdc.getDiskImage(u) !== null,
      mediaName: this.names.get(u === 0 ? 'a' : 'b') ?? '',
      writeProtected: m.fdc.writeProtect[u],
      motorOn: m.diskIf.motorOn && active === u,
    }));
  }

  insert(id: string, media: DriveMedia, name: string): void {
    this.m.loadDisk(media as DskImage, unitOf(id));
    this.names.set(id, name);
  }

  eject(id: string): void {
    this.m.fdc.ejectDisk(unitOf(id));
    this.names.delete(id);
  }

  /** Bit-stream (HFE) images save back as HFE; a regular 512-byte-sector disk
   *  as the headerless `.dsk` MSX-DOS tools expect; anything irregular (a
   *  protected DMK, odd layouts) as an extended CPC DSK so no track detail is
   *  lost. */
  save(id: string): { data: Uint8Array; name: string } | null {
    const unit = unitOf(id);
    const image = this.m.fdc.getDiskImage(unit);
    if (!image) return null;
    const base = baseName(this.names.get(id) ?? '');
    let out: { data: Uint8Array; name: string };
    if (image.bitstream) out = { data: serializeHFE(image), name: `${base}.hfe` };
    else if (isRegularMsxImage(image)) out = { data: serializeMsxRaw(image), name: `${base}.dsk` };
    else out = { data: serializeDSK(image), name: `${base}.edsk` };
    this.m.fdc.clearDirty(unit);
    return out;
  }

  setWriteProtect(id: string, on: boolean): void {
    this.m.fdc.writeProtect[unitOf(id)] = on;
  }

  image(id: string): DskImage | null {
    return this.m.fdc.getDiskImage(unitOf(id));
  }

  /** Record a drive's mounted-media name without going through insert(). */
  noteName(id: string, name: string): void { this.names.set(id, name); }
}
