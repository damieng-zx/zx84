/**
 * Spectrum DiskService — one flat drive list over every drive-bearing device
 * the machine has fitted: the +3's internal uPD765A units ('a'/'b') and, when
 * enabled, the MGT +D ('plusd:0'/1), Beta Disk ('beta:0'/1) and Interface 1
 * microdrives ('mdv:0'-'mdv:7').
 *
 * The service owns machine mutation only (insert/eject/serialize/WP); signal
 * updates and persistence remain shell reflection, exactly as before.
 */

import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { parseHFE, serializeHFE, isHFE } from '@/media/floppy/hfe.ts';
import { parseSCP, isScp } from '@/media/floppy/scp.ts';
import { parseMgt, serializeMgt, mgtExtFromName } from '@/media/floppy/mgt-image.ts';
import { parseTrd, serializeTrd } from '@/media/floppy/trd-image.ts';
import { parseScl, serializeScl, isScl, SCL_DISK_FORMAT } from '@/media/floppy/scl-image.ts';

/** Parse a +D image (.mgt/.img, or .hfe/.scp flux) — the exact format chain
 *  the +D loader used before this service existed. */
export function parsePlusDMedia(data: Uint8Array, filename: string): DskImage | null {
  return isHFE(data) ? parseHFE(data) : isScp(data) ? parseSCP(data) : parseMgt(data, mgtExtFromName(filename));
}

/** Parse a Beta Disk image (.trd/.scl, or .hfe/.scp flux) — verbatim chain. */
export function parseBetaMedia(data: Uint8Array): DskImage | null {
  if (isHFE(data)) return parseHFE(data);
  if (isScp(data)) return parseSCP(data);
  if (isScl(data)) return parseScl(data);
  return parseTrd(data);
}

function baseName(name: string, fallback: string): string {
  return name.replace(/\.[^.]+$/, '') || fallback;
}

export class SpectrumDiskService implements DiskService {
  /** Mounted media names per drive id (media identity is service state). */
  private names = new Map<string, string>();

  constructor(private readonly s: Spectrum) {}

  get drives(): readonly DriveDescriptor[] {
    const s = this.s;
    const out: DriveDescriptor[] = [];
    const motorUnit = s.fdc.motorOn ? s.fdc.currentUnit & 1 : -1;
    if (s.variant.hasFDC) {
      for (let u = 0; u < 2; u++) {
        out.push({
          id: u === 0 ? 'a' : 'b',
          label: u === 0 ? 'A:' : 'B:',
          loaded: s.fdc.getDiskImage(u) !== null,
          mediaName: this.names.get(u === 0 ? 'a' : 'b') ?? '',
          writeProtected: s.fdc.writeProtect[u],
          motorOn: motorUnit === u,
        });
      }
    }
    if (s.mgtPlusD.enabled) {
      for (let u = 0; u < 2; u++) {
        out.push({
          id: `plusd:${u}`,
          label: `+D ${u === 0 ? 'C' : 'D'}:`,
          loaded: s.mgtPlusD.fdc.getDiskImage(u) !== null,
          mediaName: this.names.get(`plusd:${u}`) ?? '',
          writeProtected: s.mgtPlusD.fdc.writeProtect[u],
          motorOn: s.mgtPlusD.fdc.motorOn,
        });
      }
    }
    if (s.betaDisk.enabled) {
      for (let u = 0; u < 2; u++) {
        out.push({
          id: `beta:${u}`,
          label: `Beta ${u === 0 ? 'A' : 'B'}:`,
          loaded: s.betaDisk.fdc.getDiskImage(u) !== null,
          mediaName: this.names.get(`beta:${u}`) ?? '',
          writeProtected: s.betaDisk.fdc.writeProtect[u],
          motorOn: s.betaDisk.fdc.motorOn,
        });
      }
    }
    if (s.interface1.enabled) {
      for (let u = 0; u < 8; u++) {
        const d = s.interface1.drives[u];
        out.push({
          id: `mdv:${u}`,
          label: `Microdrive ${u + 1}`,
          loaded: d.inserted,
          mediaName: this.names.get(`mdv:${u}`) ?? '',
          writeProtected: d.writeProtected,
          motorOn: d.motorOn,
        });
      }
    }
    return out;
  }

  insert(id: string, media: DriveMedia, name: string): void {
    const s = this.s;
    if (id === 'a' || id === 'b') {
      s.loadDisk(media as DskImage, id === 'a' ? 0 : 1);
    } else if (id.startsWith('plusd:')) {
      s.loadPlusDDisk(media as DskImage, Number(id.slice(6)));
    } else if (id.startsWith('beta:')) {
      s.loadBetaDiskDisk(media as DskImage, Number(id.slice(5)));
    } else if (id.startsWith('mdv:')) {
      s.interface1.drives[Number(id.slice(4))].loadMDR(media as Uint8Array);
    } else {
      throw new Error(`Unknown drive: ${id}`);
    }
    this.names.set(id, name);
  }

  eject(id: string): void {
    const s = this.s;
    if (id === 'a' || id === 'b') s.fdc.ejectDisk(id === 'a' ? 0 : 1);
    else if (id.startsWith('plusd:')) s.mgtPlusD.fdc.ejectDisk(Number(id.slice(6)));
    else if (id.startsWith('beta:')) s.betaDisk.fdc.ejectDisk(Number(id.slice(5)));
    else if (id.startsWith('mdv:')) s.interface1.drives[Number(id.slice(4))].eject();
    this.names.delete(id);
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const s = this.s;
    const mounted = this.names.get(id) ?? '';
    if (id === 'a' || id === 'b') {
      const unit = id === 'a' ? 0 : 1;
      const image = s.fdc.getDiskImage(unit);
      if (!image) return null;
      const base = baseName(mounted, 'disk');
      // HFE-sourced disks save back as HFE (writes re-encoded into the retained
      // bitstream, protection tracks preserved); everything else as DSK.
      const out = image.bitstream
        ? { data: serializeHFE(image), name: `${base}.hfe` }
        : { data: serializeDSK(image), name: `${base}.dsk` };
      s.fdc.clearDirty(unit);   // the on-disk file now matches the image
      return out;
    }
    if (id.startsWith('plusd:')) {
      const unit = Number(id.slice(6));
      const image = s.mgtPlusD.fdc.getDiskImage(unit);
      if (!image) return null;
      const base = baseName(mounted, 'plusd');
      const out = image.bitstream
        ? { data: serializeHFE(image), name: `${base}.hfe` }
        : { data: serializeMgt(image, 'mgt'), name: `${base}.mgt` };
      s.mgtPlusD.fdc.clearDirty(unit);
      return out;
    }
    if (id.startsWith('beta:')) {
      const unit = Number(id.slice(5));
      const image = s.betaDisk.fdc.getDiskImage(unit);
      if (!image) return null;
      const base = baseName(mounted, 'betadisk');
      const out = image.bitstream
        ? { data: serializeHFE(image), name: `${base}.hfe` }
        : image.diskFormat === SCL_DISK_FORMAT
        ? { data: serializeScl(image), name: `${base}.scl` }
        : { data: serializeTrd(image), name: `${base}.trd` };
      s.betaDisk.fdc.clearDirty(unit);
      return out;
    }
    if (id.startsWith('mdv:')) {
      const unit = Number(id.slice(4));
      const drive = s.interface1.drives[unit];
      if (!drive.inserted) return null;
      const base = baseName(mounted, `mdr${unit + 1}`);
      return { data: drive.toMDR(), name: `${base}.mdr` };
    }
    return null;
  }

  setWriteProtect(id: string, on: boolean): void {
    const s = this.s;
    if (id === 'a' || id === 'b') s.fdc.writeProtect[id === 'a' ? 0 : 1] = on;
    else if (id.startsWith('plusd:')) s.mgtPlusD.fdc.writeProtect[Number(id.slice(6))] = on;
    else if (id.startsWith('beta:')) s.betaDisk.fdc.writeProtect[Number(id.slice(5))] = on;
    else if (id.startsWith('mdv:')) s.interface1.drives[Number(id.slice(4))].writeProtected = on;
  }

  /** Record a drive's mounted-media name without going through insert() —
   *  used by shell paths that mutate the FDC directly (blank inserts). */
  noteName(id: string, name: string): void { this.names.set(id, name); }
}
