/**
 * Apple II 5.25" floppy codec: raw sector images (`.dsk`, `.do`, `.po` and the
 * 13-sector `.d13`) and the Disk II GCR encoding they materialise into.
 *
 * `.dsk`/`.do` are raw 256-byte-sector dumps in DOS 3.3 order (the physical
 * sector for file index i is DOS_SKEW[i]); `.po` is the same bytes in ProDOS
 * physical order. Both are 35-track single-sided 140K images in practice (40
 * tracks appear too), and both materialise into the shared `DskImage` model.
 * `.d13` is a 13-sector DOS 3.2 disk (116,480 bytes) in physical sector order.
 *
 * The Disk II controller is a bit-level device — it shifts a raw GCR bit
 * stream into software that does its own address-field decoding — so a logical
 * sector image has to be encoded into the nibbles a real drive would present.
 * `layoutTrack` describes that stream (disk bytes and self-sync gaps) for both
 * the 16-sector 6-and-2 format of DOS 3.3 / ProDOS and the 13-sector 5-and-3
 * format of DOS 3.1-3.2.1; `encodeTrack` renders it as plain nibbles and
 * `apple2-bitstream.ts` as the bit cells that turn past the drive head.
 * `decodeNibbleSectors` reads sectors back out of a nibble stream. Raw nibble
 * (`.nib`), `.2mg` and flux-level (`.woz`) images live in their own modules.
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

/** ProDOS physical -> logical sector map: `PRODOS_SKEW[physical]` is the index of
 *  the 256-byte file sector stored in that physical sector, so ProDOS block 0 is
 *  physical sectors 0 and 2, block 1 is 4 and 6, and so on (CiderPress's
 *  ProDOS-order table). A `.po` image lists the sectors in this logical order. */
export const PRODOS_SKEW = [
  0x0, 0x8, 0x1, 0x9, 0x2, 0xA, 0x3, 0xB,
  0x4, 0xC, 0x5, 0xD, 0x6, 0xE, 0x7, 0xF,
] as const;

/** Index, within a track's 16 file sectors, of the sector stored at `phys`. */
function fileSectorFor(order: Apple2DiskOrder, phys: number): number {
  return order === 'dos' ? DOS_SKEW[phys] : PRODOS_SKEW[phys];
}

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

/** Data field on disk: 342 encoded values plus the checksum code. */
const DATA_FIELD_BYTES = 343;

// ── 13-sector 5-and-3 (DOS 3.1 - 3.2.1) ──────────────────────────────────

export const APPLE2_SECTORS_PER_TRACK_13 = 13;

/**
 * The 32 disk bytes a 5-bit value is written as on a 13-sector disk. The
 * original Disk II state machine (the 13-sector P6 PROM) needs a 1 bit at least
 * every other cell, so a valid byte has its high bit set and no two adjacent
 * 0 bits. Of the 34 such bytes, `$AA` and `$D5` are reserved for the field
 * marks; the remaining 32, in ascending order, carry the values 0-31.
 */
function buildWriteTable53(): number[] {
  const table: number[] = [];
  for (let b = 0x80; b < 0x100; b++) {
    if (b === 0xAA || b === 0xD5) continue;
    if (((~b & 0xFF) & ((~b & 0xFF) >> 1)) !== 0) continue;   // two adjacent zeros
    table.push(b);
  }
  return table;
}

export const GCR53_WRITE_TABLE: readonly number[] = buildWriteTable53();

/** Code → 5-bit value, the inverse of {@link GCR53_WRITE_TABLE}. */
export const GCR53_READ_TABLE: Uint8Array = (() => {
  const inv = new Uint8Array(256);
  GCR53_WRITE_TABLE.forEach((code, value) => { inv[code] = value; });
  return inv;
})();

/** Values in a 5-and-3 data field before its checksum: 154 + 256. */
const FIVE_AND_THREE_VALUES = 410;
/** Groups of five bytes in a sector (the 256th byte is carried on its own). */
const GROUPS_53 = 51;

/**
 * 5-and-3 encode a 256-byte sector into the 411 five-bit values a 13-sector
 * data field carries (410 plus the checksum).
 *
 * The sector is taken in 51 groups of five bytes (A B C D E) plus a final byte.
 * Each byte's top five bits become one "primary" value (5 × 51 + 1 = 256); the
 * low three bits of the group, fifteen in all, become three "secondary" values:
 * A, B and C's low bits in bits 4-2, D's and E's bit 2, 1, 0 in bits 1 and 0 of
 * the first, second and third. The final byte's low three bits are a 154th
 * secondary. The 154 secondaries go first, then the 256 primaries, and as in
 * 6-and-2 the disk holds the running XOR with a closing checksum value.
 */
export function encodeSector5and3(sector: Uint8Array): Uint8Array {
  if (sector.length !== APPLE2_SECTOR_SIZE) {
    throw new Error(`Apple II sector must be 256 bytes, got ${sector.length}`);
  }
  const raw = new Uint8Array(FIVE_AND_THREE_VALUES);
  const second = 0, primary = 154;
  for (let g = 0; g < GROUPS_53; g++) {
    const at = g * 5;
    const [a, b, c, d, e] = [sector[at], sector[at + 1], sector[at + 2], sector[at + 3], sector[at + 4]];
    for (let k = 0; k < 5; k++) raw[primary + k * GROUPS_53 + g] = sector[at + k] >> 3;
    raw[second + g] = ((a & 7) << 2) | (((d >> 2) & 1) << 1) | ((e >> 2) & 1);
    raw[second + GROUPS_53 + g] = ((b & 7) << 2) | (((d >> 1) & 1) << 1) | ((e >> 1) & 1);
    raw[second + 2 * GROUPS_53 + g] = ((c & 7) << 2) | ((d & 1) << 1) | (e & 1);
  }
  raw[primary + 255] = sector[255] >> 3;
  raw[second + 153] = sector[255] & 7;

  const out = new Uint8Array(FIVE_AND_THREE_VALUES + 1);
  let prev = 0;
  for (let k = 0; k < FIVE_AND_THREE_VALUES; k++) {
    out[k] = raw[k] ^ prev;
    prev = raw[k];
  }
  out[FIVE_AND_THREE_VALUES] = prev;
  return out;
}

/** Inverse of {@link encodeSector5and3}. */
export function decodeSector5and3(values: Uint8Array): Uint8Array {
  const raw = new Uint8Array(FIVE_AND_THREE_VALUES);
  let acc = 0;
  for (let k = 0; k < FIVE_AND_THREE_VALUES; k++) { acc ^= values[k]; raw[k] = acc & 0x1F; }
  const out = new Uint8Array(APPLE2_SECTOR_SIZE);
  const primary = 154;
  for (let g = 0; g < GROUPS_53; g++) {
    const s0 = raw[g], s1 = raw[GROUPS_53 + g], s2 = raw[2 * GROUPS_53 + g];
    const at = g * 5;
    out[at] = (raw[primary + g] << 3) | (s0 >> 2);
    out[at + 1] = (raw[primary + GROUPS_53 + g] << 3) | (s1 >> 2);
    out[at + 2] = (raw[primary + 2 * GROUPS_53 + g] << 3) | (s2 >> 2);
    out[at + 3] = (raw[primary + 3 * GROUPS_53 + g] << 3)
      | (((s0 >> 1) & 1) << 2) | (((s1 >> 1) & 1) << 1) | ((s2 >> 1) & 1);
    out[at + 4] = (raw[primary + 4 * GROUPS_53 + g] << 3)
      | ((s0 & 1) << 2) | ((s1 & 1) << 1) | (s2 & 1);
  }
  out[255] = (raw[primary + 255] << 3) | (raw[153] & 7);
  return out;
}

/** Whether a 5-and-3 field's running XOR closes at zero (checksum OK). */
export function fiveAndThreeChecksumOk(values: Uint8Array): boolean {
  let acc = 0;
  for (let k = 0; k <= FIVE_AND_THREE_VALUES; k++) acc ^= values[k];
  return (acc & 0x1F) === 0;
}

// ── Track layout ─────────────────────────────────────────────────────────

/** Where a synthesised track's disk bytes go: a self-sync byte is `$FF`
 *  followed by two 0 bits on a real disk (10 bit cells), which a plain nibble
 *  stream cannot show, so the layout reports it separately. */
export interface Apple2TrackSink {
  byte(value: number): void;
  sync(count: number): void;
}

/** Gap lengths, in self-sync bytes, of a synthesised track. */
export interface Apple2TrackGaps {
  /** Before the first sector. */
  gap1: number;
  /** Between a sector's address field and its data field. */
  gap2: number;
  /** After each data field. */
  gap3: number;
}

/** The gaps the nibble encoder has always used (6656-nibble tracks). */
export const APPLE2_NIBBLE_GAPS: Apple2TrackGaps = { gap1: 48, gap2: 6, gap3: 27 };

/**
 * Lay out one formatted track (physical sector order, r = 0..n-1) the way
 * DOS formats it, per *Beneath Apple DOS*:
 *
 *   gap1  D5 AA 96 vol trk sec chk DE AA EB  gap2  D5 AA AD
 *   data + checksum  DE AA EB  gap3            (per sector)
 *
 * A 13-sector track has address prologue `D5 AA B5` and a 411-byte 5-and-3
 * data field; a 16-sector one `D5 AA 96` and a 343-byte 6-and-2 field. The
 * address field is 4-and-4 encoded either way. Missing sectors are left out.
 */
export function layoutTrack(
  sink: Apple2TrackSink,
  sectors: readonly (Uint8Array | null)[],
  track: number,
  volume: number,
  sectorsPerTrack: 13 | 16,
  gaps: Apple2TrackGaps,
): void {
  const thirteen = sectorsPerTrack === APPLE2_SECTORS_PER_TRACK_13;
  sink.sync(gaps.gap1);
  for (let phys = 0; phys < sectorsPerTrack; phys++) {
    const sector = sectors[phys];
    if (!sector) continue;
    sink.byte(0xD5); sink.byte(0xAA); sink.byte(thirteen ? 0xB5 : 0x96);
    const checksum = (volume ^ track ^ phys) & 0xFF;
    for (const v of [volume, track, phys, checksum]) {
      const [a, b] = fourAndFour(v);
      sink.byte(a); sink.byte(b);
    }
    sink.byte(0xDE); sink.byte(0xAA); sink.byte(0xEB);
    sink.sync(gaps.gap2);
    sink.byte(0xD5); sink.byte(0xAA); sink.byte(0xAD);
    if (thirteen) {
      const five = encodeSector5and3(sector);
      for (let i = 0; i < five.length; i++) sink.byte(GCR53_WRITE_TABLE[five[i] & 0x1F]);
    } else {
      const six = encodeSector6and2(sector);
      for (let i = 0; i < six.length; i++) sink.byte(gcr6(six[i]));
    }
    sink.byte(0xDE); sink.byte(0xAA); sink.byte(0xEB);
    sink.sync(gaps.gap3);
  }
}

/**
 * Encode one 16-sector track (physical sector order r = 0..15) as plain
 * nibbles, one byte per disk byte with the sync bytes as ordinary `$FF`s,
 * padded to {@link APPLE2_TRACK_NIBBLES} — the shape of a `.nib` track.
 */
export function encodeTrack(
  sectors: (Uint8Array | null)[],
  track: number,
  volume = 254,
): Uint8Array {
  const out: number[] = [];
  layoutTrack({
    byte: (b) => { out.push(b & 0xFF); },
    sync: (n) => { for (let i = 0; i < n; i++) out.push(0xFF); },
  }, sectors, track, volume, 16, APPLE2_NIBBLE_GAPS);
  // Pad (or trim) to a uniform track length.
  while (out.length < APPLE2_TRACK_NIBBLES) out.push(0xFF);
  return Uint8Array.from(out.slice(0, APPLE2_TRACK_NIBBLES));
}

/** Read the data fields back out of an encoded 16-sector track, taken as one
 *  revolution that wraps round (physical order). */
export function decodeTrack(nibbles: Uint8Array): (Uint8Array | null)[] {
  return decodeNibbleSectors(nibbles, 16, true);
}

/**
 * Find the sectors in a nibble stream: every address field (prologue, 4-and-4
 * volume / track / sector / checksum) whose checksum holds, followed within 64
 * nibbles by a data field whose checksum holds. `circular` treats the stream as
 * one revolution (fields may wrap from the end to the start); otherwise it is a
 * plain run, as decoded from more than one revolution of a bit track. The first
 * good copy of each sector wins. Returns sectors by physical number.
 */
export function decodeNibbleSectors(
  nibbles: Uint8Array,
  sectorsPerTrack: 13 | 16,
  circular: boolean,
): (Uint8Array | null)[] {
  const thirteen = sectorsPerTrack === APPLE2_SECTORS_PER_TRACK_13;
  const addrMark = thirteen ? 0xB5 : 0x96;
  const fieldLen = thirteen ? FIVE_AND_THREE_VALUES + 1 : DATA_FIELD_BYTES;
  const out: (Uint8Array | null)[] = new Array(sectorsPerTrack).fill(null);
  const n = nibbles.length;
  const limit = circular ? n : n - 11;
  const at = (p: number): number => (circular ? nibbles[p % n] : (p < n ? nibbles[p] : 0));
  for (let i = 0; i < limit; i++) {
    if (at(i) !== 0xD5 || at(i + 1) !== 0xAA || at(i + 2) !== addrMark) continue;
    const vol = fourAndFourDecode(at(i + 3), at(i + 4));
    const trk = fourAndFourDecode(at(i + 5), at(i + 6));
    const sec = fourAndFourDecode(at(i + 7), at(i + 8));
    const chk = fourAndFourDecode(at(i + 9), at(i + 10));
    if ((vol ^ trk ^ sec ^ chk) !== 0 || sec >= sectorsPerTrack || out[sec]) continue;
    let found = -1;
    for (let k = 11; k < 11 + 64; k++) {
      if (at(i + k) === 0xD5 && at(i + k + 1) === 0xAA && at(i + k + 2) === 0xAD) { found = i + k + 3; break; }
    }
    if (found < 0 || (!circular && found + fieldLen > n)) continue;
    const values = new Uint8Array(fieldLen);
    if (thirteen) {
      for (let k = 0; k < fieldLen; k++) values[k] = GCR53_READ_TABLE[at(found + k)];
      if (!fiveAndThreeChecksumOk(values)) continue;
      out[sec] = decodeSector5and3(values);
    } else {
      for (let k = 0; k < fieldLen; k++) values[k] = gcrRead(at(found + k));
      if (!sixAndTwoChecksumOk(values)) continue;
      out[sec] = decodeSector6and2(values);
    }
  }
  return out;
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

/**
 * Strip a container header from a raw image. Disks circulate wrapped in a
 * MacBinary I header (128 bytes: a zero byte, a Pascal-style file name, zero
 * bytes at offsets 74 and 82, and the data-fork length at 83-86), and a few come
 * from an emulator that prefixes "SIMSYSTEM_IIE" and a sector-order table (30
 * bytes). Without this every sector is read at the wrong offset and the boot
 * sector is garbage. Anything unrecognised is returned unchanged.
 */
export function unwrapApple2Image(data: Uint8Array): Uint8Array {
  if (data.length > 128 + TRACK_BYTES
    && data[0] === 0 && data[74] === 0 && data[82] === 0 && data[1] >= 1 && data[1] <= 63) {
    const fork = ((data[83] << 24) | (data[84] << 16) | (data[85] << 8) | data[86]) >>> 0;
    if (fork > 0 && fork <= data.length - 128 && apple2ImageLength(fork) !== null) {
      return data.subarray(128, 128 + fork);
    }
  }
  const SIMSYSTEM = 'SIMSYSTEM_IIE';
  if (data.length > 30 + TRACK_BYTES
    && Array.from(SIMSYSTEM).every((c, i) => data[i] === c.charCodeAt(0))
    && apple2ImageLength(data.length - 30) !== null) {
    return data.subarray(30);
  }
  return data;
}

export function isApple2DiskLength(length: number): boolean {
  return apple2ImageLength(length) !== null;
}

/** A ProDOS volume directory key block (previous 0, next 3, storage type $F) at
 *  block 2: file offset $400 in a ProDOS-order image. In a DOS-order one that
 *  offset is track 0 sector 4 (boot code), so the signature does not occur there. */
function hasProdosVolumeHeader(data: Uint8Array): boolean {
  return data.length > 0x405
    && data[0x400] === 0x00 && data[0x401] === 0x00
    && data[0x402] === 0x03 && data[0x403] === 0x00
    && (data[0x404] >> 4) === 0xF;
}

/** DOS 3.3 logical sector -> physical sector: the inverse of {@link DOS_SKEW}. */
const DOS_PHYSICAL: readonly number[] = (() => {
  const inv = new Array<number>(APPLE2_SECTORS_PER_TRACK).fill(0);
  DOS_SKEW.forEach((logical, physical) => { inv[logical] = physical; });
  return inv;
})();

/** Length of the DOS 3.3 catalog sector chain (track 17) that is readable when
 *  the image is taken in `order`. The VTOC at track 17 sector 0 names the first
 *  catalog sector and every link is a *DOS logical* sector number, so the file
 *  position of the next sector depends on the order: the logical index itself in
 *  a DOS-order image, but the ProDOS position of that logical sector's physical
 *  sector in a ProDOS-order one. DOS builds the chain strictly downward (15 -> 14
 *  -> ... -> 1 -> 0/0), so only that canonical link counts: the right order
 *  walks the whole catalog while the wrong one breaks at the second hop, and an
 *  odd cracked catalog cannot tip the decision. */
function catalogChainLength(data: Uint8Array, order: Apple2DiskOrder): number {
  const track = 17 * TRACK_BYTES;
  if (data.length < track + TRACK_BYTES || data[track + 1] !== 17) return 0;
  let sector = data[track + 2];
  let length = 0;
  while (sector > 0 && sector < APPLE2_SECTORS_PER_TRACK) {
    const index = order === 'dos' ? sector : PRODOS_SKEW[DOS_PHYSICAL[sector]];
    const at = track + index * APPLE2_SECTOR_SIZE;
    length++;
    const nextTrack = data[at + 1], nextSector = data[at + 2];
    if (nextTrack === 0 && nextSector === 0) break;           // end of chain
    if (nextTrack !== 17 || nextSector !== sector - 1) break;  // not the canonical link
    sector = nextSector;
  }
  return length;
}

/**
 * Pick the sector order of a raw 140K image from its contents.
 *
 * The extension is only a hint: `.po` files in the wild are frequently DOS-order
 * dumps and `.do` ones ProDOS-order, so no extension is trusted. Evidence, in order:
 *
 *  1. A ProDOS volume header at block 2 means ProDOS order.
 *  2. A DOS 3.3 catalog chain that only reads cleanly under one skew decides it.
 *  3. Otherwise DOS order - custom-format boot disks (Origin, Broderbund, ...)
 *     labelled `.po` boot with the DOS skew, and ProDOS-format ones carry the
 *     header caught by step 2.
 */
export function detectApple2DiskOrder(data: Uint8Array): Apple2DiskOrder {
  data = unwrapApple2Image(data);
  if (hasProdosVolumeHeader(data)) return 'prodos';
  const dos = catalogChainLength(data, 'dos');
  const prodos = catalogChainLength(data, 'prodos');
  if (prodos > dos) return 'prodos';
  return 'dos';
}

/** Build a `DskImage` from a raw `.dsk`/`.do`/`.po` image. */
export function parseApple2Disk(data: Uint8Array, order: Apple2DiskOrder): DskImage {
  data = unwrapApple2Image(data);
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
      const fileIndex = fileSectorFor(order, phys);
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
      const fileIndex = fileSectorFor(order, phys);
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

// ── 13-sector images (.d13) ─────────────────────────────────────────────

const TRACK_BYTES_13 = APPLE2_SECTOR_SIZE * APPLE2_SECTORS_PER_TRACK_13;

/** Whether a byte length is a whole 13-sector image (35 or 40 tracks). */
export function isApple2D13Length(length: number): boolean {
  return length === 35 * TRACK_BYTES_13 || length === 40 * TRACK_BYTES_13;
}

/** Build a `DskImage` from a 13-sector `.d13` image. DOS 3.2 applies its
 *  sector interleave in software, so the file holds the sectors in physical
 *  order: file sector i of a track is the one whose address field says i. */
export function parseApple2Disk13(data: Uint8Array): DskImage {
  if (!isApple2D13Length(data.length)) {
    throw new Error(`Not a 13-sector Apple II image (${data.length} bytes)`);
  }
  const numTracks = data.length / TRACK_BYTES_13;
  const tracks: (DskTrack | null)[][] = [];
  for (let t = 0; t < numTracks; t++) {
    const sectors: DskSector[] = [];
    const sectorMap = new Map<number, number>();
    for (let phys = 0; phys < APPLE2_SECTORS_PER_TRACK_13; phys++) {
      const off = t * TRACK_BYTES_13 + phys * APPLE2_SECTOR_SIZE;
      sectorMap.set(phys, sectors.length);
      sectors.push({
        c: t, h: 0, r: phys, n: 1, st1: 0, st2: 0,
        data: data.slice(off, off + APPLE2_SECTOR_SIZE),
      });
    }
    tracks.push([{ sectors, sectorMap, gap3: 0, filler: 0xFF }]);
  }
  return {
    format: 'standard', numTracks, numSides: 1, tracks,
    diskFormat: 'Apple DOS 3.2 (13-sector)', protection: '',
  };
}

/** Serialize a 13-sector `DskImage` back to a `.d13` image. */
export function serializeApple2Disk13(image: DskImage): Uint8Array {
  const out = new Uint8Array(image.numTracks * TRACK_BYTES_13);
  for (let t = 0; t < image.numTracks; t++) {
    for (const sector of image.tracks[t]?.[0]?.sectors ?? []) {
      if (sector.r < 0 || sector.r >= APPLE2_SECTORS_PER_TRACK_13) continue;
      out.set(sector.data.subarray(0, APPLE2_SECTOR_SIZE), t * TRACK_BYTES_13 + sector.r * APPLE2_SECTOR_SIZE);
    }
  }
  return out;
}
