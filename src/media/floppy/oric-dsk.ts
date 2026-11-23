/**
 * Oric `.dsk` disk images.
 *
 * `.dsk` on the Oric hides **two** different container formats, and the only
 * reliable way to tell them apart is the signature in the first eight bytes:
 *
 *   `MFM_DISK`  the current format, what Euphoric and Oricutron write and what
 *               effectively every archive holds. The 256-byte header gives
 *               sides, tracks and, at offset 12, the geometry *type* (1 = all
 *               of side 0 then side 1, which is what Oric images use). Each
 *               track then follows as ~6400 bytes of **MFM cells**, with the
 *               sector layout recoverable only from the ID and data marks — so
 *               it is parsed with the same track decoder the HFE images use.
 *
 *   `ORICDISK`  the obsolete format. Sides, tracks and sectors in the header,
 *               then plain 256-byte sectors, side-major, track by track.
 *
 * Both are read into the shared `DskImage`, which is what the WD1793 works on,
 * so a mounted Oric disk behaves exactly like any other machine's.
 */

import type { DskImage, DskSector, DskTrack } from './disk-image.ts';

/** The two container signatures. */
export const ORIC_DSK_MFM = 'MFM_DISK';
export const ORIC_DSK_OLD = 'ORICDISK';

/** Bytes a track occupies in an `MFM_DISK` image (6250 of data plus filler). */
const MFM_TRACK_BYTES = 6400;
/** Bytes a sector holds in an `ORICDISK` image. */
const OLD_SECTOR_BYTES = 256;

export type OricDskKind = 'mfm' | 'old';

/** Which container `data` is, or null when it is neither. */
export function oricDskKind(data: Uint8Array): OricDskKind | null {
  if (asciiAt(data, 0, 8) === ORIC_DSK_MFM) return 'mfm';
  if (asciiAt(data, 0, 8) === ORIC_DSK_OLD) return 'old';
  return null;
}

/** True when `data` is an Oric disk image of either kind. */
export function isOricDsk(data: Uint8Array): boolean {
  return oricDskKind(data) !== null;
}

/** A 32-bit little-endian field from the header. */
function u32(data: Uint8Array, at: number): number {
  return (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
}

/** An ASCII string from the header. */
function asciiAt(data: Uint8Array, offset: number, len: number): string {
  let out = '';
  for (let i = 0; i < len && offset + i < data.length; i++) {
    out += String.fromCharCode(data[offset + i]);
  }
  return out;
}

/**
 * Parse either container into the shared image.
 *
 * The `MFM_DISK` path reads the header's sides and tracks, then decodes each
 * 6400-byte track through the HFE track decoder — the cell stream is the same
 * MFM encoding, so the same decoder that recovers sectors from an HFE file
 * recovers them here.
 */
export function parseOricDsk(data: Uint8Array): DskImage {
  const kind = oricDskKind(data);
  if (kind === null) throw new Error('Not an Oric disk image (no MFM_DISK or ORICDISK signature)');
  return kind === 'mfm' ? parseMfmDsk(data) : parseOldDsk(data);
}

/**
 * `MFM_DISK`: sides, tracks, geometry type in the header; then the track cell
 * streams. Geometry type 1 — all of side 0, then all of side 1 — is what Oric
 * images carry; type 2 interleaves the tracks of each cylinder.
 */
function parseMfmDsk(data: Uint8Array): DskImage {
  const sides = u32(data, 8);
  const tracks = u32(data, 12);
  const geometry = u32(data, 16);
  if (sides < 1 || sides > 2) throw new Error(`Oric disk declares ${sides} sides`);
  if (tracks < 1 || tracks > 84) throw new Error(`Oric disk declares ${tracks} tracks`);

  const out: (DskTrack | null)[][] = [];
  for (let t = 0; t < tracks; t++) out.push(new Array<DskTrack | null>(sides).fill(null));

  let offset = 256;
  for (let i = 0; i < sides * tracks; i++) {
    // Type 1 lists side 0's tracks then side 1's; type 2 alternates.
    const track = geometry === 2 ? Math.floor(i / sides) : i % tracks;
    const side = geometry === 2 ? i % sides : Math.floor(i / tracks);
    if (offset + MFM_TRACK_BYTES > data.length) {
      throw new Error(`Oric disk is truncated at track ${track} side ${side}`);
    }
    const cells = data.subarray(offset, offset + MFM_TRACK_BYTES);
    out[track][side] = decodeTrackCells(cells);
    offset += MFM_TRACK_BYTES;
  }

  return { format: 'standard', diskFormat: 'Oric disk', protection: '', numTracks: tracks, numSides: sides, tracks: out };
}

/**
 * Read one track's sectors straight out of its byte stream.
 *
 * The `MFM_DISK` body is not a cell stream at all, despite the name: each track
 * is the **decoded** sector data the controller delivers, with the address and
 * data marks still in place. An ID field is `A1 A1 A1 FE C H R N CRC CRC` and a
 * payload is `A1 A1 A1 FB <128<<N bytes> CRC CRC`, so the sectors are found by
 * scanning for the marks rather than by undoing any encoding. (Hand-reading a
 * Sedoric track shows `SEDORIC` sitting in the payload this way; trying to
 * re-encode to clock cells first, which the HFE path needs, finds nothing.)
 *
 * Returns null for a track with no readable sectors, which is a formatted-blank
 * or protected track.
 */
function decodeTrackCells(bytes: Uint8Array): DskTrack | null {
  const sectors: DskSector[] = [];
  let p = 0;
  while (p < bytes.length - 6) {
    // Look for an address mark: three A1 sync bytes then FE.
    if (!(bytes[p] === 0xA1 && bytes[p + 1] === 0xA1 && bytes[p + 2] === 0xA1
      && bytes[p + 3] === 0xFE)) { p++; continue; }

    const c = bytes[p + 4];
    const h = bytes[p + 5];
    const r = bytes[p + 6];
    const n = bytes[p + 7];
    const size = 128 << (n & 7);

    // The data field follows, after its own three-A1 mark and an FB (or F8 for
    // a deleted-data sector).
    let q = p + 10;
    let mark = 0;
    for (; q < bytes.length - 3; q++) {
      if (bytes[q] === 0xA1 && bytes[q + 1] === 0xA1 && bytes[q + 2] === 0xA1
        && (bytes[q + 3] === 0xFB || bytes[q + 3] === 0xF8)) {
        mark = bytes[q + 3];
        q += 4;
        break;
      }
    }
    if (mark === 0) { p += 4; continue; }
    if (q + size > bytes.length) { p += 4; continue; }

    sectors.push({
      c, h, r, n,
      st1: 0,
      // A deleted-data sector is ST2's Control Mark bit, which is how the FDC
      // reports it, so the reader sees the same status a real drive would.
      st2: mark === 0xF8 ? 0x40 : 0,
      data: bytes.slice(q, q + size),
    });
    p = q + size + 2;   // step past the payload and its CRC
  }
  if (sectors.length === 0) return null;
  return {
    sectors,
    sectorMap: new Map(sectors.map((s, i) => [s.r, i])),
    gap3: 0,
    filler: 0x4E,
    encoding: 'mfm',
  };
}

/**
 * `ORICDISK`: sides, tracks and sectors per track in the header, then plain
 * 256-byte sectors, all of side 0 then all of side 1, track by track.
 */
function parseOldDsk(data: Uint8Array): DskImage {
  const sides = u32(data, 8);
  const tracks = u32(data, 12);
  const sectorsPerTrack = u32(data, 16);
  if (sides < 1 || sides > 2) throw new Error(`Oric disk declares ${sides} sides`);
  if (tracks < 1 || tracks > 84) throw new Error(`Oric disk declares ${tracks} tracks`);
  if (sectorsPerTrack < 1 || sectorsPerTrack > 32) {
    throw new Error(`Oric disk declares ${sectorsPerTrack} sectors a track`);
  }

  const out: (DskTrack | null)[][] = [];
  for (let t = 0; t < tracks; t++) out.push(new Array<DskTrack | null>(sides).fill(null));

  let offset = 256;
  for (let side = 0; side < sides; side++) {
    for (let track = 0; track < tracks; track++) {
      const sectors: DskSector[] = [];
      for (let id = 1; id <= sectorsPerTrack; id++) {
        if (offset + OLD_SECTOR_BYTES > data.length) {
          throw new Error(`Oric disk is truncated at track ${track} side ${side}`);
        }
        sectors.push({
          c: track, h: side, r: id, n: 1, st1: 0, st2: 0,
          data: data.slice(offset, offset + OLD_SECTOR_BYTES),
        });
        offset += OLD_SECTOR_BYTES;
      }
      out[track][side] = {
        sectors,
        sectorMap: new Map(sectors.map((s, i) => [s.r, i])),
        gap3: 0,
        filler: 0x00,
        encoding: 'mfm',
      };
    }
  }
  return { format: 'standard', diskFormat: 'Oric disk', protection: '', numTracks: tracks, numSides: sides, tracks: out };
}

/**
 * Write the image back as an `ORICDISK` container — the format that needs no
 * cell encoding, so a disk an emulated ROM has written can always be saved.
 *
 * An `MFM_DISK` write-back would be preferable for compatibility, but it means
 * re-encoding every track's cell stream; saving in the simple container is
 * lossless for ordinary discs and never produces a file that claims an encoding
 * it does not have.
 */
export function serializeOricDsk(image: DskImage): Uint8Array {
  const sectorsPerTrack = image.tracks[0]?.[0]?.sectors.length ?? 17;
  const header = new Uint8Array(256);
  for (let i = 0; i < ORIC_DSK_OLD.length; i++) header[i] = ORIC_DSK_OLD.charCodeAt(i);
  const put = (at: number, v: number): void => {
    header[at] = v & 0xFF; header[at + 1] = (v >> 8) & 0xFF;
    header[at + 2] = (v >> 16) & 0xFF; header[at + 3] = (v >> 24) & 0xFF;
  };
  put(8, image.numSides);
  put(12, image.numTracks);
  put(16, sectorsPerTrack);

  const parts: Uint8Array[] = [header];
  for (let side = 0; side < image.numSides; side++) {
    for (let track = 0; track < image.numTracks; track++) {
      const sectors = image.tracks[track]?.[side]?.sectors ?? [];
      for (let id = 1; id <= sectorsPerTrack; id++) {
        const sector = sectors.find(s => s.r === id);
        const buf = new Uint8Array(OLD_SECTOR_BYTES);
        if (sector) buf.set(sector.data.subarray(0, OLD_SECTOR_BYTES));
        parts.push(buf);
      }
    }
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
