/**
 * SCL disk images (.scl) for the Beta Disk interface.
 *
 * SCL is the common compact distribution format for TR-DOS software. Unlike a
 * TRD it is not a sector dump — it is a file archive:
 *
 *   "SINCLAIR"            8-byte magic
 *   N                     1 byte  — number of files
 *   N × 14-byte headers   filename(8) type(1) start(2,LE) lenBytes(2,LE) sectors(1)
 *   file data             each file's `sectors × 256` bytes, concatenated
 *   checksum              4 bytes (ignored)
 *
 * We reconstruct a standard 640K (80-track DS) TR-DOS disk: the catalog is
 * written to track 0, files are laid out contiguously from track 1, and the
 * disk-info sector is filled in — then we hand the flat image to parseTrd so the
 * result is an ordinary DskImage the WD1793 drives off.
 */

import type { DskImage } from './dsk.ts';
import {
  TRD_SECTOR_BYTES, TRD_SPT, parseTrd, writeTrdInfoSector, type TrdGeometry,
} from './trd-image.ts';

const MAGIC = 'SINCLAIR';
const SCL_HEADER_LEN = 14;   // per-file catalog entry in the SCL
const TRD_CATALOG_ENTRY = 16; // per-file catalog entry on a TR-DOS disk

/** True if the bytes start with the SCL "SINCLAIR" signature. */
export function isScl(data: Uint8Array): boolean {
  if (data.length < 9) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Parse an .scl archive into a DskImage (a materialised 80-track DS TR-DOS
 * disk). Returns null if the signature is missing.
 */
export function parseScl(data: Uint8Array): DskImage | null {
  if (!isScl(data)) return null;

  const g: TrdGeometry = { tracks: 80, sides: 2 };
  const totalSectors = g.tracks * g.sides * TRD_SPT;
  const flat = new Uint8Array(g.tracks * g.sides * TRD_SPT * TRD_SECTOR_BYTES);

  const fileCount = data[8];
  let headerPtr = 9;
  let dataPtr = 9 + fileCount * SCL_HEADER_LEN;

  // Files are laid out contiguously in TR-DOS logical-sector order, starting at
  // track 1 (track 0 holds the catalog + info sector).
  let cursorTrack = 1;
  let cursorSector = 0;

  for (let i = 0; i < fileCount; i++) {
    const h = headerPtr + i * SCL_HEADER_LEN;
    const sectors = data[h + 13];
    const dataLen = sectors * TRD_SECTOR_BYTES;

    // Stop if the archive is truncated or the disk is full.
    if (dataPtr + dataLen > data.length) break;
    const start = cursorTrack * TRD_SPT + cursorSector;
    if (start + sectors > totalSectors) break;

    // Catalog entry in track 0: the SCL's 14 header bytes, then the file's
    // starting sector and track (bytes 14/15).
    const catOff = i * TRD_CATALOG_ENTRY;
    flat.set(data.subarray(h, h + SCL_HEADER_LEN), catOff);
    flat[catOff + 14] = cursorSector;
    flat[catOff + 15] = cursorTrack;

    // File data, contiguous from the cursor (logical sectors map linearly to
    // byte offsets in the cylinder-major/sides-interleaved image).
    flat.set(data.subarray(dataPtr, dataPtr + dataLen), start * TRD_SECTOR_BYTES);

    dataPtr += dataLen;
    const next = start + sectors;
    cursorTrack = Math.floor(next / TRD_SPT);
    cursorSector = next % TRD_SPT;
  }

  writeTrdInfoSector(flat, g, {
    fileCount,
    firstFreeTrack: cursorTrack,
    firstFreeSector: cursorSector,
  });

  const img = parseTrd(flat);
  img.diskFormat = 'TR-DOS (SCL)';
  return img;
}
