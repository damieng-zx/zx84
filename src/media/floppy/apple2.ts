/**
 * Apple II 5.25" floppy codec: raw sector images (`.dsk`, `.do`, `.po`) and the
 * Disk II GCR encoding they materialise into.
 *
 * `.dsk`/`.do` are raw 256-byte-sector dumps in DOS 3.3 order (the physical
 * sector for file index i is DOS_SKEW[i]); `.po` is the same bytes in ProDOS
 * physical order. Both are 35-track single-sided 140K images in practice (40
 * tracks appear too), and both materialise into the shared `DskImage` model.
 *
 * The Disk II controller is a bit-level device — it shifts a raw GCR bit
 * stream into software that does its own address-field decoding — so a logical
 * sector image has to be encoded into the nibbles a real drive would present.
 * `encodeTrack` builds that stream; `decodeTrack` reads it back (used for write
 * -back and for tests). Only the standard 16-sector 6-and-2 layout is produced;
 * copy-protected / raw-nibble images are not this codec's job.
 */

import type { DskImage, DskSector, DskTrack } from './disk-image.ts';

export const APPLE2_SECTOR_SIZE = 256;
export const APPLE2_SECTORS_PER_TRACK = 16;
export const APPLE2_TRACKS = 35;
/** Nibbles in one synthesised track. A real Disk II track holds ~6250-6656
 *  bytes; padding every track to one length keeps the rotational bit rate
 *  uniform, which is what the controller's timing model assumes. */
export const APPLE2_TRACK_NIBBLES = 6656;

/** DOS 3.3 physical → logical sector map: `DOS_SKEW[physical]` is the DOS
 *  logical sector stored in that physical sector (address-field number). This
 *  is the table the DOS 3.3 boot loader walks (`13 11 9 7 5 3 1 …`) to read
 *  the logical sectors in order, so it is the authoritative direction. */
export const DOS_SKEW = [
  0x0, 0x7, 0xE, 0x6, 0xD, 0x5, 0xC, 0x4,
  0xB, 0x3, 0xA, 0x2, 0x9, 0x1, 0x8, 0xF,
] as const;

/**
 * The 64 disk bytes ("GCR codes") a 6-bit value is written as. The rule is the
 * one the Disk II boot ROM itself applies when it builds its decode table: a
 * candidate `x` (0x00-0x7F, written on disk as `x | 0x80`) is valid when it has
 * two adjacent 1 bits, and the "~((x<<1)|x)" mask — which marks each pair of
 * adjacent 0 bits — has at most one bit set (no run of three 0s). Sorting the
 * valid codes ascending makes the index the 6-bit value they carry.
 */
function buildWriteTable(): number[] {
  const table: number[] = [];
  for (let x = 0; x < 0x80; x++) {
    if (((x << 1) & x) === 0) continue;                 // no two adjacent 1s
    const gaps = ~((x << 1) | x) & 0x7E;                // one bit per adjacent-0 pair
    if ((gaps & (gaps - 1)) !== 0) continue;            // three consecutive 0s
    table.push(x | 0x80);
  }
  return table;
}

export const GCR_WRITE_TABLE: readonly number[] = buildWriteTable();

/** Code → 6-bit value, the inverse of {@link GCR_WRITE_TABLE}. */
export const GCR_READ_TABLE: Uint8Array = (() => {
  const inv = new Uint8Array(256);
  GCR_WRITE_TABLE.forEach((code, value) => { inv[code] = value; });
  return inv;
})();

export function gcr6(value: number): number { return GCR_WRITE_TABLE[value & 0x3F]; }
export function gcrRead(code: number): number { return GCR_READ_TABLE[code & 0xFF]; }

/** 4-and-4 encoding of one address-field byte into two disk bytes. */
export function fourAndFour(v: number): [number, number] {
  return [((v >> 1) & 0x7F) | 0xAA, (v & 0xFF) | 0xAA];
}

/** Decode a 4-and-4 pair (`a` read first, then `b`). */
export function fourAndFourDecode(a: number, b: number): number {
  return (((a << 1) | 1) & b) & 0xFF;
}

/**
 * 6-and-2 encode a 256-byte sector into the 343 six-bit values a Disk II track
 * carries.
 *
 * The raw layout is 86 "low two bits" values followed by 256 "high six bits"
 * values. Each sector byte's low two bits are spread one bit per pass across
 * the 86 values: pass p (byte j, p = j/86) uses bits 2p and 2p+1, with the
 * reader shifting bit 2p out first into the high half of the recovered field —
 * so bit 2p holds bit 1 of the byte and bit 2p+1 holds bit 0.
 *
 * What goes on the disk is the *running XOR* of that raw sequence (each value
 * XOR the previous one): the controller-side reader (the boot ROM) recovers
 * each raw value by XORing the bytes as it shifts them in, and that same
 * accumulator is the checksum. The extra 343rd value returns the XOR to zero.
 */
export function encodeSector6and2(sector: Uint8Array): Uint8Array {
  if (sector.length !== APPLE2_SECTOR_SIZE) {
    throw new Error(`Apple II sector must be 256 bytes, got ${sector.length}`);
  }
  const raw = new Uint8Array(342);
  for (let j = 0; j < APPLE2_SECTOR_SIZE; j++) {
    const pass = Math.floor(j / 86);
    const i = j % 86;
    const b = sector[j];
    raw[i] |= ((b >> 1) & 1) << (2 * pass);
    raw[i] |= (b & 1) << (2 * pass + 1);
  }
  for (let j = 0; j < APPLE2_SECTOR_SIZE; j++) raw[86 + j] = (sector[j] >> 2) & 0x3F;

  const out = new Uint8Array(343);
  let prev = 0;
  for (let k = 0; k < 342; k++) {
    out[k] = raw[k] ^ prev;
    prev = raw[k];
  }
  out[342] = prev;              // makes the reader's running XOR end at 0
  return out;
}

/** Inverse of {@link encodeSector6and2}: undo the running XOR, then unpack. */
export function decodeSector6and2(values: Uint8Array): Uint8Array {
  const raw = new Uint8Array(342);
  let acc = 0;
  for (let k = 0; k < 342; k++) { acc ^= values[k]; raw[k] = acc & 0x3F; }
  const out = new Uint8Array(APPLE2_SECTOR_SIZE);
  for (let j = 0; j < APPLE2_SECTOR_SIZE; j++) {
    const pass = Math.floor(j / 86);
    const chunk = raw[j % 86];
    const low2 = (((chunk >> (2 * pass)) & 1) << 1) | ((chunk >> (2 * pass + 1)) & 1);
    out[j] = ((raw[86 + j] & 0x3F) << 2) | low2;
  }
  return out;
}

/** Whether the 343 on-disk values' running XOR closes at zero (checksum OK). */
export function sixAndTwoChecksumOk(values: Uint8Array): boolean {
  let acc = 0;
  for (let k = 0; k < 343; k++) acc ^= values[k];
  return (acc & 0x3F) === 0;
}

/** 6-and-2 encode a sector into GCR codes. */
function encodeDataField(sector: Uint8Array): Uint8Array {
  const six = encodeSector6and2(sector);
  const out = new Uint8Array(343);
  for (let i = 0; i < 343; i++) out[i] = gcr6(six[i]);
  return out;
}

/** Data field on disk: 342 encoded values plus the checksum code. */
const DATA_FIELD_BYTES = 343;

/**
 * Encode one 16-sector track (physical sector order r = 0..15) into the nibble
 * stream the Disk II shifts out. Layout per sector, per *Beneath Apple DOS*:
 *
 *   gap(sync) D5 AA 96 vol trk sec chk DE AA EB  gap  D5 AA AD
 *   342 data + checksum  DE AA EB  gap
 */
export function encodeTrack(
  sectors: (Uint8Array | null)[],
  track: number,
  volume = 254,
): Uint8Array {
  const out: number[] = [];
  const gap = (n: number) => { for (let i = 0; i < n; i++) out.push(0xFF); };
  const push = (...bytes: number[]) => { for (const b of bytes) out.push(b & 0xFF); };

  gap(48);
  for (let phys = 0; phys < APPLE2_SECTORS_PER_TRACK; phys++) {
    const sector = sectors[phys];
    if (!sector) continue;
    // Address field.
    push(0xD5, 0xAA, 0x96);
    const checksum = (volume ^ track ^ phys) & 0xFF;
    for (const v of [volume, track, phys, checksum]) {
      const [a, b] = fourAndFour(v);
      push(a, b);
    }
    push(0xDE, 0xAA, 0xEB);
    gap(6);
    // Data field.
    push(0xD5, 0xAA, 0xAD);
    const data = encodeDataField(sector);
    for (let i = 0; i < data.length; i++) out.push(data[i]);
    push(0xDE, 0xAA, 0xEB);
    gap(27);
  }
  // Pad (or trim) to a uniform track length.
  while (out.length < APPLE2_TRACK_NIBBLES) out.push(0xFF);
  return Uint8Array.from(out.slice(0, APPLE2_TRACK_NIBBLES));
}

/** Read the data fields back out of an encoded track (physical order). */
export function decodeTrack(nibbles: Uint8Array): (Uint8Array | null)[] {
  const out: (Uint8Array | null)[] = new Array(APPLE2_SECTORS_PER_TRACK).fill(null);
  const n = nibbles.length;
  let i = 0;
  while (i < n) {
    // Find an address prologue D5 AA 96.
    if (nibbles[i] !== 0xD5 || nibbles[(i + 1) % n] !== 0xAA
        || nibbles[(i + 2) % n] !== 0x96) { i++; continue; }
    const at = (k: number) => nibbles[(i + k) % n];
    const vol = fourAndFourDecode(at(3), at(4));
    const trk = fourAndFourDecode(at(5), at(6));
    const sec = fourAndFourDecode(at(7), at(8));
    const chk = fourAndFourDecode(at(9), at(10));
    if ((vol ^ trk ^ sec ^ chk) !== 0) { i += 11; continue; }
    // Look for the data prologue after this address field.
    let j = i + 11;
    let found = -1;
    for (let k = 0; k < 64; k++) {
      const p = (j + k) % n;
      if (isDataPrologue(nibbles, p, n)) { found = (p + 3) % n; break; }
    }
    if (found < 0) { i += 11; continue; }
    const values = new Uint8Array(DATA_FIELD_BYTES);
    for (let k = 0; k < DATA_FIELD_BYTES; k++) values[k] = gcrRead(nibbles[(found + k) % n]);
    if (!sixAndTwoChecksumOk(values)) { i += 11; continue; }
    const sectorData = decodeSector6and2(values);
    if (sec < APPLE2_SECTORS_PER_TRACK) out[sec] = sectorData;
    i += 11;
  }
  return out;
}

function isDataPrologue(nibbles: Uint8Array, p: number, n: number): boolean {
  return nibbles[p] === 0xD5 && nibbles[(p + 1) % n] === 0xAA && nibbles[(p + 2) % n] === 0xAD;
}

export type Apple2DiskOrder = 'dos' | 'prodos';

const TRACK_BYTES = APPLE2_SECTOR_SIZE * APPLE2_SECTORS_PER_TRACK;

/**
 * The whole-track length a raw image represents, or null if it is not a sector
 * image at all. Images in the wild often carry a few stray bytes (a trailing
 * header or checksum, a short final sector) around the real 140K, so a length
 * within a sector or so of a whole number of tracks is accepted and trimmed or
 * padded to it; anything further off is not treated as a disk.
 */
export function apple2ImageLength(length: number): number | null {
  if (length <= 0) return null;
  const tracks = Math.round(length / TRACK_BYTES);
  if (tracks < 1) return null;
  return Math.abs(length - tracks * TRACK_BYTES) < 1024 ? tracks * TRACK_BYTES : null;
}

export function isApple2DiskLength(length: number): boolean {
  return apple2ImageLength(length) !== null;
}

/**
 * Pick the sector order of a raw 140K image. `.po` is ProDOS order and `.do`
 * DOS order by definition; `.dsk` is ambiguous in the wild, so it is sniffed
 * for the ProDOS volume directory header. That header (previous block 0, next
 * block 3, storage type $F) sits in block 2 - file offset $400 in a ProDOS-order
 * image, but track 0 sector 4 (boot code) in a DOS-order one, where the DOS VTOC
 * is at $11000 instead - so the signature does not occur in a DOS-order disk.
 */
export function detectApple2DiskOrder(data: Uint8Array, name: string): Apple2DiskOrder {
  if (/\.po$/i.test(name)) return 'prodos';
  if (/\.do$/i.test(name)) return 'dos';
  const isProdosVolumeHeader = data.length > 0x405
    && data[0x400] === 0x00 && data[0x401] === 0x00
    && data[0x402] === 0x03 && data[0x403] === 0x00
    && (data[0x404] >> 4) === 0xF;
  return isProdosVolumeHeader ? 'prodos' : 'dos';
}

/** Build a `DskImage` from a raw `.dsk`/`.do`/`.po` image. */
export function parseApple2Disk(data: Uint8Array, order: Apple2DiskOrder): DskImage {
  const length = apple2ImageLength(data.length);
  if (length === null) {
    throw new Error(`Not an Apple II disk image (${data.length} bytes)`);
  }
  if (data.length !== length) {
    const fixed = new Uint8Array(length);          // zero-pads a short image
    fixed.set(data.subarray(0, length));
    data = fixed;
  }
  const numTracks = length / TRACK_BYTES;
  const tracks: (DskTrack | null)[][] = [];
  for (let t = 0; t < numTracks; t++) {
    const sectors: DskSector[] = [];
    const sectorMap = new Map<number, number>();
    const trackBase = t * APPLE2_SECTORS_PER_TRACK * APPLE2_SECTOR_SIZE;
    for (let phys = 0; phys < APPLE2_SECTORS_PER_TRACK; phys++) {
      const fileIndex = order === 'dos' ? DOS_SKEW[phys] : phys;
      const off = trackBase + fileIndex * APPLE2_SECTOR_SIZE;
      sectorMap.set(phys, sectors.length);
      sectors.push({
        c: t, h: 0, r: phys, n: 1, st1: 0, st2: 0,
        data: data.slice(off, off + APPLE2_SECTOR_SIZE),
      });
    }
    tracks.push([{ sectors, sectorMap, gap3: 0, filler: 0xFF }]);
  }
  return {
    format: 'standard',
    numTracks,
    numSides: 1,
    tracks,
    diskFormat: order === 'dos' ? 'Apple DOS 3.3' : 'ProDOS',
    protection: '',
  };
}

/** Volume number a DOS 3.3 disk is formatted with when it does not say. */
export const APPLE2_DEFAULT_VOLUME = 254;

/**
 * The volume number the address fields should carry. A sector image does not
 * record it, yet DOS 3.3's RWTS rejects a disk whose volume differs from the
 * one it was asked for - and boot code does ask for a specific one (the Eamon
 * disks are volume 61, Sierra's 254). Two places say what the disk expects:
 *
 *  1. The boot-time IOB in the DOS image on tracks 0-2 (`01 60 01 VV tt ss FB B7`:
 *     table type, slot 6, drive 1, volume, track, sector, then the DCT
 *     pointer to $B7FB). A non-zero VV is what the loader will demand.
 *  2. Failing that, the DOS 3.3 VTOC (track 17, sector 0, byte 6), recognised by
 *     its catalog link and DOS release byte.
 *
 * Anything else, including ProDOS disks, keeps the default.
 */
export function apple2VolumeNumber(image: DskImage): number {
  for (let t = 0; t < 3; t++) {
    for (const sector of image.tracks[t]?.[0]?.sectors ?? []) {
      const d = sector.data;
      for (let i = 0; i + 8 <= d.length; i++) {
        if (d[i] === 0x01 && d[i + 1] === 0x60 && d[i + 2] === 0x01
          && d[i + 6] === 0xFB && d[i + 7] === 0xB7 && d[i + 3] >= 1 && d[i + 3] <= 254) {
          return d[i + 3];
        }
      }
    }
  }
  const vtoc = image.tracks[17]?.[0]?.sectors.find(s => s.r === 0)?.data;
  if (!vtoc || vtoc.length < 7) return APPLE2_DEFAULT_VOLUME;
  const looksLikeVtoc = vtoc[1] === 17 && vtoc[3] >= 1 && vtoc[3] <= 4;
  const volume = vtoc[6];
  return looksLikeVtoc && volume >= 1 && volume <= 254 ? volume : APPLE2_DEFAULT_VOLUME;
}

/** Serialize a `DskImage` back to a raw sector image in the given order. */
export function serializeApple2Disk(image: DskImage, order: Apple2DiskOrder): Uint8Array {
  const out = new Uint8Array(image.numTracks * APPLE2_SECTORS_PER_TRACK * APPLE2_SECTOR_SIZE);
  for (let t = 0; t < image.numTracks; t++) {
    const track = image.tracks[t]?.[0];
    if (!track) continue;
    const trackBase = t * APPLE2_SECTORS_PER_TRACK * APPLE2_SECTOR_SIZE;
    for (const sector of track.sectors) {
      const phys = sector.r;
      if (phys < 0 || phys >= APPLE2_SECTORS_PER_TRACK) continue;
      const fileIndex = order === 'dos' ? DOS_SKEW[phys] : phys;
      const off = trackBase + fileIndex * APPLE2_SECTOR_SIZE;
      out.set(sector.data.subarray(0, APPLE2_SECTOR_SIZE), off);
    }
  }
  return out;
}

/** A blank (unformatted) 35-track image: every sector filled with 0x00. */
export function blankApple2Disk(tracks = APPLE2_TRACKS): DskImage {
  const data = new Uint8Array(tracks * APPLE2_SECTORS_PER_TRACK * APPLE2_SECTOR_SIZE);
  return parseApple2Disk(data, 'dos');
}
