/**
 * Commodore 1581 disks (`.d81`).
 *
 * A 1581 disk is a 3.5" double-density MFM disk: 80 cylinders, two sides, ten
 * 512-byte sectors a track (numbered 1-10), 800K in all. The `.d81` file is
 * the DOS's view of it, a flat run of 256-byte sectors: logical track t
 * (1-80) is cylinder t-1 and holds 40 of them, the first twenty on side 0 and
 * the rest on side 1, a pair to each 512-byte sector. That is the layout of
 * the +D's `.mgt` dumps (cylinder-major, sides interleaved), so the disk is
 * held as the shared `DskImage` the WD177x core, the Drives pane and the
 * floppy sounds already speak, read and written through the same codec. An
 * optional 3200-byte error table after the sectors (one byte per 256-byte
 * sector) is dropped.
 *
 * The directory and BAM live on track 40: the header at 40/0, the BAM in
 * 40/1-2 and the first directory sector at 40/3.
 */

import type { DskImage } from './disk-image.ts';
import { parseMgt, serializeMgt } from './mgt-image.ts';

export const D81_SIZE = 819_200;
/** A `.d81` with the per-sector error table appended. */
export const D81_SIZE_WITH_ERRORS = D81_SIZE + 3_200;

export const D81_FORMAT_NAME = 'Commodore 1581 (D81)';

/** `data` is the size of a `.d81`. */
export function isD81(data: Uint8Array): boolean {
  return data.length === D81_SIZE || data.length === D81_SIZE_WITH_ERRORS;
}

/** Read a `.d81`; null when it is not one. */
export function parseD81(data: Uint8Array): DskImage | null {
  if (!isD81(data)) return null;
  const image = parseMgt(data.subarray(0, D81_SIZE), 'mgt');
  if (!image) return null;
  image.diskFormat = D81_FORMAT_NAME;
  return image;
}

/** The disk as a `.d81`, or null when it no longer has the 1581's layout (a
 *  format with other sector counts, say). */
export function serializeD81(image: DskImage): Uint8Array | null {
  if (image.numTracks !== 80 || image.numSides !== 2) return null;
  for (let c = 0; c < 80; c++) {
    for (let h = 0; h < 2; h++) {
      const track = image.tracks[c]?.[h];
      if (!track || track.sectors.length !== 10) return null;
      for (let r = 1; r <= 10; r++) {
        const at = track.sectorMap.get(r);
        if (at === undefined || track.sectors[at].data.length !== 512) return null;
      }
    }
  }
  return serializeMgt(image, 'mgt');
}

const PETSCII_SHIFTED_SPACE = 0xA0;

/** A freshly formatted disk with an empty directory, as `.d81` bytes. */
export function blankD81Bytes(name = 'ZX84', id = '01'): Uint8Array {
  const out = new Uint8Array(D81_SIZE);
  const sector = (track: number, s: number): number => ((track - 1) * 40 + s) * 256;
  const text = (s: string, width: number): number[] => {
    const bytes = [...s.toUpperCase().slice(0, width)].map(c => c.charCodeAt(0));
    while (bytes.length < width) bytes.push(PETSCII_SHIFTED_SPACE);
    return bytes;
  };
  const idBytes = text(id, 2);

  const header = sector(40, 0);
  out.set([40, 3, 0x44, 0], header);
  out.set(text(name, 16), header + 4);
  out.set([PETSCII_SHIFTED_SPACE, PETSCII_SHIFTED_SPACE], header + 0x14);
  out.set(idBytes, header + 0x16);
  out[header + 0x18] = PETSCII_SHIFTED_SPACE;
  out.set([0x33, 0x44], header + 0x19);                     // DOS version "3D"
  out.set([PETSCII_SHIFTED_SPACE, PETSCII_SHIFTED_SPACE], header + 0x1B);

  // Two BAM sectors of 40 tracks each: a free count then five bytes of bits.
  const bamSector = (first: number, bam: number, next: [number, number]): void => {
    out.set([next[0], next[1], 0x44, 0xBB], bam);
    out.set(idBytes, bam + 4);
    out[bam + 6] = 0xC0;
    for (let i = 0; i < 40; i++) {
      const track = first + i;
      const at = bam + 0x10 + i * 6;
      const free = new Array<boolean>(40).fill(true);
      if (track === 40) { free[0] = free[1] = free[2] = free[3] = false; }
      out[at] = free.filter(Boolean).length;
      free.forEach((f, s) => { if (f) out[at + 1 + (s >> 3)] |= 1 << (s & 7); });
    }
  };
  bamSector(1, sector(40, 1), [40, 2]);
  bamSector(41, sector(40, 2), [0, 0xFF]);

  out.set([0, 0xFF], sector(40, 3));                         // the directory: one empty sector, last
  return out;
}

/** A blank formatted disk as the shared image. */
export function blankD81(name?: string, id?: string): DskImage {
  return parseD81(blankD81Bytes(name, id))!;
}
