/**
 * SAM DiskService — the two internal 3.5" drives.
 *
 * Media identity (the mounted filename, and which container it came from) is
 * service state; the drives themselves hold only the parsed image.
 */

import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { isHFE, parseHFE, serializeHFE } from '@/media/floppy/hfe.ts';
import { isScp, parseSCP } from '@/media/floppy/scp.ts';
import { isMgtSize, mgtExtFromName, parseMgt, serializeMgt } from '@/media/floppy/mgt-image.ts';
import type { SamMachine } from '../sam-machine.ts';

/** ASCII at `off`, for container magic checks. */
function ascii(d: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && off + i < d.length; i++) s += String.fromCharCode(d[off + i]);
  return s;
}

/** True for a CPC/+3 EDSK or DSK container, which is NOT a SAM raw dump. */
export function isDskContainer(d: Uint8Array): boolean {
  const magic = ascii(d, 0, 8);
  return magic === 'EXTENDED' || magic === 'MV - CPC';
}

/** True for the "Aley's disk backup" (.sad) container header. */
export function isSad(d: Uint8Array): boolean {
  return ascii(d, 0, 18) === "Aley's disk backup";
}

/**
 * Parse SAM disk media.
 *
 * `.dsk` is the awkward one: everywhere else in zx84 it means the CPC/+3
 * container, but on the SAM it is almost always a raw 819,200-byte MGT dump.
 * So the decision is made by CONTENT, and the container magic is checked
 * BEFORE the size table — an 819,200-byte EDSK is perfectly possible, and
 * would otherwise be misread as a raw dump.
 *
 * Returns null when nothing recognises it, so the caller can report why.
 */
export function parseSamMedia(data: Uint8Array, filename: string): DskImage | null {
  if (isHFE(data)) return parseHFE(data);
  if (isScp(data)) return parseSCP(data);
  // A .sad is deliberately refused rather than guessed at — see the media
  // service for the reason.
  if (isSad(data)) return null;
  if (isDskContainer(data)) return null;
  if (isMgtSize(data.length)) return parseMgt(data, mgtExtFromName(filename));
  return null;
}

function baseName(name: string, fallback: string): string {
  return name.replace(/\.[^.]+$/, '') || fallback;
}

export class SamDiskService implements DiskService {
  /** Mounted media name per drive id. */
  private readonly names = new Map<string, string>();
  /** True when the drive's image arrived as an HFE, so it saves back as one. */
  private readonly fromHfe = new Map<string, boolean>();

  constructor(private readonly m: SamMachine) {}

  private static unitOf(id: string): number { return id === '2' ? 1 : 0; }

  get drives(): readonly DriveDescriptor[] {
    const disk = this.m.disk;
    const out: DriveDescriptor[] = [];
    for (let u = 0; u < 2; u++) {
      const id = u === 0 ? '1' : '2';
      out.push({
        id,
        label: `Drive ${u + 1}:`,
        loaded: disk.image(u) !== null,
        mediaName: this.names.get(id) ?? '',
        writeProtected: disk.writeProtected(u),
        motorOn: disk.motorOn(u),
      });
    }
    return out;
  }

  insert(id: string, media: DriveMedia, name: string): void {
    const unit = SamDiskService.unitOf(id);
    this.m.disk.insert(unit, media as DskImage);
    this.names.set(id, name);
    this.fromHfe.set(id, /\.hfe$/i.test(name));
  }

  eject(id: string): void {
    this.m.disk.eject(SamDiskService.unitOf(id));
    this.names.delete(id);
    this.fromHfe.delete(id);
  }

  image(id: string): DskImage | null {
    return this.m.disk.image(SamDiskService.unitOf(id));
  }

  /** Serialize the drive's image back out, in the format it arrived as. */
  save(id: string): { data: Uint8Array; name: string } | null {
    const img = this.image(id);
    if (!img) return null;
    const stem = baseName(this.names.get(id) ?? '', `sam-drive${id}`);
    if (this.fromHfe.get(id)) {
      return { data: serializeHFE(img), name: `${stem}.hfe` };
    }
    return { data: serializeMgt(img, 'mgt'), name: `${stem}.mgt` };
  }

  setWriteProtect(id: string, on: boolean): void {
    this.m.disk.setWriteProtect(SamDiskService.unitOf(id), on);
  }
}
