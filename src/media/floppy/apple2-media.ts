/**
 * Apple II disk images of every kind, as one mountable model.
 *
 * Whatever the file — a sector image (`.dsk`/`.do`/`.po`, the 13-sector `.d13`,
 * a `.2mg` wrapping either order or nibbles), a raw nibble image (`.nib`) or a
 * bit-level `.woz` — it becomes an {@link Apple2Disk}: the shared `DskImage`
 * sector model (for the drive pane, and as the image a sector format is saved
 * back from) plus the bit-cell tracks the Disk II actually reads and writes.
 *
 * The bit tracks are the disk. A write changes their cells; {@link foldApple2Track}
 * decodes a written track back into the sector model, and
 * {@link serializeApple2Media} saves the disk in the format it came in — the
 * sector image for a sector format, the nibbles for `.nib`, the bits for `.woz`.
 */

import type { DskImage, DskSector, DskTrack } from './disk-image.ts';
import {
  APPLE2_SECTOR_SIZE, APPLE2_TRACK_NIBBLES,
  apple2VolumeNumber, detectApple2DiskOrder, isApple2D13Length, parseApple2Disk, parseApple2Disk13,
  serializeApple2Disk, serializeApple2Disk13, unwrapApple2Image, type Apple2DiskOrder,
} from './apple2.ts';
import {
  APPLE2_BIT_TIMING, APPLE2_NO_TRACK, APPLE2_QUARTER_TRACKS, bitTrackToNib, decodeBitTrack,
  encodeTrackBits, nibToBitTrack, standardTmap, type Apple2BitDisk,
} from './apple2-bitstream.ts';
import { isWoz, parseWoz, serializeWoz } from './apple2-woz.ts';

export type Apple2MediaFormat = 'dsk' | 'd13' | 'nib' | '2mg' | 'woz';

/** A `.2mg` file's wrapping, kept so a save writes the same container back. */
export interface TwoImgWrapper {
  /** The header as read (its size field says how long). */
  header: Uint8Array;
  /** 0 DOS order, 1 ProDOS order, 2 nibbles. */
  format: number;
  comment: Uint8Array | null;
  creatorData: Uint8Array | null;
}

/** What a WOZ image said about itself, carried into a save. */
export interface WozDetails {
  creator: string;
  version: number;
  synchronized: boolean;
  cleaned: boolean;
  bootSectorFormat: number;
  compatibleHardware: number;
  requiredRam: number;
  meta: string | null;
  fluxQuarterTracks: number;
}

export interface Apple2DiskInfo {
  /** The bit-cell tracks under the head: the disk itself. */
  bits: Apple2BitDisk;
  /** The format it was loaded from, and is saved back as. */
  source: Apple2MediaFormat;
  /** Sector layout written tracks are decoded as (13 or 16 sectors). */
  sectorsPerTrack: 13 | 16;
  /** Sector order of a 16-sector image file. */
  order: Apple2DiskOrder;
  /** Address-field volume number used when nibblizing. */
  volume: number;
  twoImg: TwoImgWrapper | null;
  woz: WozDetails | null;
}

/** A mounted Apple II disk: the sector view plus the bit tracks. */
export interface Apple2Disk extends DskImage {
  apple2: Apple2DiskInfo;
}

export function isApple2Disk(image: DskImage): image is Apple2Disk {
  return (image as Partial<Apple2Disk>).apple2 !== undefined;
}

/** `.nib` track lengths: 6656 bytes (the usual) or 6384 (`.nb2`). */
const NIB_TRACK_LENGTHS = [APPLE2_TRACK_NIBBLES, 6384];

function nibTrackLength(length: number): number | null {
  for (const per of NIB_TRACK_LENGTHS) {
    if (length === 35 * per || length === 40 * per) return per;
  }
  return null;
}

// ── Building the bit tracks ───────────────────────────────────────────────

/** Sectors of track `t` by physical number. */
function physicalSectors(image: DskImage, t: number, count: number): (Uint8Array | null)[] {
  const out: (Uint8Array | null)[] = new Array(count).fill(null);
  for (const s of image.tracks[t]?.[0]?.sectors ?? []) {
    if (s.r < 0 || s.r >= count) continue;
    if (s.data.length === APPLE2_SECTOR_SIZE) out[s.r] = s.data;
    else {
      const fixed = new Uint8Array(APPLE2_SECTOR_SIZE);
      fixed.set(s.data.subarray(0, APPLE2_SECTOR_SIZE));
      out[s.r] = fixed;
    }
  }
  return out;
}

/**
 * Attach nibblized bit tracks to a sector image (in place) and return it as an
 * {@link Apple2Disk}. Each whole track t is laid out DOS-style at quarter track
 * 4t (and its neighbours); a track with no sectors is left blank.
 */
export function nibblizeApple2Disk(
  image: DskImage,
  options: { source?: Apple2MediaFormat; order?: Apple2DiskOrder; sectorsPerTrack?: 13 | 16; volume?: number } = {},
): Apple2Disk {
  if (isApple2Disk(image)) return image;
  const sectorsPerTrack = options.sectorsPerTrack ?? 16;
  const volume = options.volume ?? apple2VolumeNumber(image);
  const numTracks = Math.min(image.numTracks, APPLE2_QUARTER_TRACKS / 4);
  const tracks = [];
  const tmap = standardTmap(numTracks);
  for (let t = 0; t < numTracks; t++) {
    const sectors = physicalSectors(image, t, sectorsPerTrack);
    tracks.push(encodeTrackBits(sectors, t, volume, sectorsPerTrack));
    if (sectors.every(s => s === null)) {
      for (let qt = 0; qt < APPLE2_QUARTER_TRACKS; qt++) if (tmap[qt] === t) tmap[qt] = APPLE2_NO_TRACK;
    }
  }
  const disk = image as Apple2Disk;
  disk.apple2 = {
    bits: { tmap, tracks, bitTiming: APPLE2_BIT_TIMING, writeProtected: false },
    source: options.source ?? (sectorsPerTrack === 13 ? 'd13' : 'dsk'),
    sectorsPerTrack,
    order: options.order ?? 'dos',
    volume,
    twoImg: null,
    woz: null,
  };
  return disk;
}

/** Which sector layout a bit disk's track 0 carries (16 unless only a
 *  13-sector address mark is found). */
function sniffSectorsPerTrack(bits: Apple2BitDisk): 13 | 16 {
  const slot = bits.tmap[0];
  if (slot === APPLE2_NO_TRACK) return 16;
  const track = bits.tracks[slot];
  if (decodeBitTrack(track, 16).some(s => s !== null)) return 16;
  return decodeBitTrack(track, 13).some(s => s !== null) ? 13 : 16;
}

/**
 * The sector view of a bit-level disk: every whole track decoded as standard
 * sectors where it can be. Tracks that do not decode (copy protection, half
 * tracks, unformatted) have no sectors, and are counted in `protection`.
 */
function sectorView(bits: Apple2BitDisk, sectorsPerTrack: 13 | 16, diskFormat: string): DskImage {
  let numTracks = 0;
  for (let qt = 0; qt < APPLE2_QUARTER_TRACKS; qt++) {
    if (bits.tmap[qt] !== APPLE2_NO_TRACK) numTracks = Math.max(numTracks, Math.floor(qt / 4) + 1);
  }
  numTracks = Math.max(numTracks, 35);
  const tracks: (DskTrack | null)[][] = [];
  let odd = 0;
  for (let t = 0; t < numTracks; t++) {
    const slot = bits.tmap[4 * t];
    const decoded = slot === APPLE2_NO_TRACK || slot === undefined
      ? new Array<Uint8Array | null>(sectorsPerTrack).fill(null)
      : decodeBitTrack(bits.tracks[slot], sectorsPerTrack);
    if (slot !== APPLE2_NO_TRACK && slot !== undefined && decoded.some(s => s === null)) odd++;
    tracks.push([sectorTrack(t, decoded)]);
  }
  return {
    format: 'standard',
    numTracks,
    numSides: 1,
    tracks,
    diskFormat,
    protection: odd > 0 ? `${odd} non-standard track${odd === 1 ? '' : 's'}` : '',
  };
}

function sectorTrack(t: number, decoded: (Uint8Array | null)[]): DskTrack {
  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();
  decoded.forEach((data, r) => {
    if (!data) return;
    sectorMap.set(r, sectors.length);
    sectors.push({ c: t, h: 0, r, n: 1, st1: 0, st2: 0, data });
  });
  return { sectors, sectorMap, gap3: 0, filler: 0xFF };
}

// ── Formats ───────────────────────────────────────────────────────────────

function fromNib(nib: Uint8Array, perTrack: number, source: Apple2MediaFormat, label: string): Apple2Disk {
  const numTracks = nib.length / perTrack;
  const tracks = [];
  for (let t = 0; t < numTracks; t++) tracks.push(nibToBitTrack(nib.subarray(t * perTrack, (t + 1) * perTrack)));
  const bits: Apple2BitDisk = { tmap: standardTmap(numTracks), tracks, bitTiming: APPLE2_BIT_TIMING, writeProtected: false };
  const sectorsPerTrack = sniffSectorsPerTrack(bits);
  const view = sectorView(bits, sectorsPerTrack, label) as Apple2Disk;
  view.apple2 = { bits, source, sectorsPerTrack, order: 'dos', volume: 254, twoImg: null, woz: null };
  return view;
}

function fromWoz(data: Uint8Array): Apple2Disk {
  const woz = parseWoz(data);
  const bits: Apple2BitDisk = {
    tmap: woz.tmap, tracks: woz.tracks, bitTiming: woz.bitTiming, writeProtected: woz.writeProtected,
  };
  const sectorsPerTrack = woz.bootSectorFormat === 2 ? 13 : sniffSectorsPerTrack(bits);
  const label = woz.infoVersion >= 3 ? 'WOZ 2.1' : woz.version === 2 ? 'WOZ 2' : 'WOZ 1';
  const view = sectorView(bits, sectorsPerTrack, woz.creator ? `${label} (${woz.creator})` : label) as Apple2Disk;
  view.apple2 = {
    bits, source: 'woz', sectorsPerTrack, order: 'dos', volume: 254, twoImg: null,
    woz: {
      creator: woz.creator, version: woz.infoVersion, synchronized: woz.synchronized, cleaned: woz.cleaned,
      bootSectorFormat: woz.bootSectorFormat, compatibleHardware: woz.compatibleHardware,
      requiredRam: woz.requiredRam, meta: woz.meta, fluxQuarterTracks: woz.fluxQuarterTracks,
    },
  };
  return view;
}

const TWO_IMG_LOCKED = 0x80000000;
const TWO_IMG_VOLUME_VALID = 0x100;

export function isTwoImg(data: Uint8Array): boolean {
  return data.length >= 64 && data[0] === 0x32 && data[1] === 0x49 && data[2] === 0x4D && data[3] === 0x47;
}

/**
 * A `.2mg` / `.2img` image: a 64-byte little-endian header ("2IMG", creator,
 * header size, version, image format 0 = DOS order / 1 = ProDOS order /
 * 2 = nibbles, flags — bit 31 locked, bit 8 "volume number in bits 0-7" —,
 * ProDOS block count, data offset and length, comment and creator-data offsets
 * and lengths) around a 140K sector image or a `.nib`. Larger (3.5", hard
 * disk) images are not Disk ][ media.
 */
function fromTwoImg(data: Uint8Array): Apple2Disk {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerSize = view.getUint16(8, true);
  const format = view.getUint32(12, true);
  const flags = view.getUint32(16, true);
  const dataOffset = view.getUint32(24, true);
  const dataLength = view.getUint32(28, true);
  const commentOffset = view.getUint32(32, true), commentLength = view.getUint32(36, true);
  const creatorOffset = view.getUint32(40, true), creatorLength = view.getUint32(44, true);
  if (dataOffset + dataLength > data.length || dataLength === 0) throw new Error('2MG image is truncated');
  const body = data.subarray(dataOffset, dataOffset + dataLength);
  const slice = (off: number, len: number) => (len > 0 && off + len <= data.length ? data.slice(off, off + len) : null);
  const wrapper: TwoImgWrapper = {
    header: data.slice(0, Math.max(64, Math.min(headerSize, dataOffset))),
    format,
    comment: slice(commentOffset, commentLength),
    creatorData: slice(creatorOffset, creatorLength),
  };
  let disk: Apple2Disk;
  if (format === 2) {
    const per = nibTrackLength(body.length);
    if (per === null) throw new Error(`2MG nibble image of ${body.length} bytes is not a 5.25" disk`);
    disk = fromNib(body, per, '2mg', '2MG nibbles');
  } else if (format === 0 || format === 1) {
    if (body.length !== 35 * 4096 && body.length !== 40 * 4096) {
      throw new Error(`2MG image of ${body.length} bytes is not a 5.25" disk (only 140K images fit the Disk ][)`);
    }
    const order: Apple2DiskOrder = format === 1 ? 'prodos' : 'dos';
    const image = parseApple2Disk(body, order);
    image.diskFormat = `2MG ${image.diskFormat}`;
    const volume = flags & TWO_IMG_VOLUME_VALID ? flags & 0xFF : undefined;
    disk = nibblizeApple2Disk(image, { source: '2mg', order, volume });
  } else {
    throw new Error(`2MG image format ${format} is not supported`);
  }
  disk.apple2.twoImg = wrapper;
  disk.apple2.bits.writeProtected = (flags & TWO_IMG_LOCKED) !== 0;
  return disk;
}

/**
 * Parse any Apple II disk image. The contents decide the format (a WOZ or 2MG
 * header, a `.nib` or `.d13` length, else a 16-sector image whose order is
 * detected); the name is consulted only to tell a `.nib` from a sector image
 * when the contents cannot.
 */
export function parseApple2Media(data: Uint8Array, filename = ''): Apple2Disk {
  if (isWoz(data)) return fromWoz(data);
  if (isTwoImg(data)) return fromTwoImg(data);
  const per = nibTrackLength(data.length);
  if (per !== null) return fromNib(data, per, 'nib', 'Nibble image');
  if (isApple2D13Length(data.length) || /\.d13$/i.test(filename)) {
    return nibblizeApple2Disk(parseApple2Disk13(data), { source: 'd13', sectorsPerTrack: 13 });
  }
  const order = detectApple2DiskOrder(data);
  return nibblizeApple2Disk(parseApple2Disk(unwrapApple2Image(data), order), { source: 'dsk', order });
}

// ── Writes and saving ─────────────────────────────────────────────────────

/**
 * Decode the bit track in `slot` back into the sector view, after a write: for
 * every whole track the slot sits at, each sector that decodes replaces the
 * stored one (a sector image keeps its old data for a sector that does not).
 */
export function foldApple2Track(disk: Apple2Disk, slot: number): void {
  const { bits, sectorsPerTrack } = disk.apple2;
  const track = bits.tracks[slot];
  if (!track) return;
  let decoded: (Uint8Array | null)[] | null = null;
  for (let t = 0; t < disk.numTracks && 4 * t < APPLE2_QUARTER_TRACKS; t++) {
    if (bits.tmap[4 * t] !== slot) continue;
    decoded ??= decodeBitTrack(track, sectorsPerTrack);
    const dsk = disk.tracks[t]?.[0];
    if (!dsk) continue;
    const isSectorImage = disk.apple2.source !== 'woz' && disk.apple2.source !== 'nib'
      && !(disk.apple2.source === '2mg' && disk.apple2.twoImg?.format === 2);
    if (isSectorImage) {
      for (const s of dsk.sectors) {
        const data = decoded[s.r];
        if (data) s.data.set(data);
      }
    } else {
      disk.tracks[t][0] = sectorTrack(t, decoded);
    }
  }
}

/** The `.nib` bytes of a bit disk: each whole track's nibbles (blank tracks
 *  are all `$FF`). */
function toNib(bits: Apple2BitDisk, numTracks: number, perTrack = APPLE2_TRACK_NIBBLES): Uint8Array {
  const out = new Uint8Array(numTracks * perTrack).fill(0xFF);
  for (let t = 0; t < numTracks; t++) {
    const slot = bits.tmap[4 * t];
    if (slot === APPLE2_NO_TRACK) continue;
    out.set(bitTrackToNib(bits.tracks[slot], perTrack), t * perTrack);
  }
  return out;
}

function twoImgBytes(disk: Apple2Disk, body: Uint8Array): Uint8Array {
  const wrap = disk.apple2.twoImg!;
  const header = wrap.header.slice();
  const tail = [wrap.comment, wrap.creatorData];
  const size = header.length + body.length + tail.reduce((n, t) => n + (t?.length ?? 0), 0);
  const out = new Uint8Array(size);
  out.set(header);
  out.set(body, header.length);
  const view = new DataView(out.buffer);
  view.setUint32(24, header.length, true);
  view.setUint32(28, body.length, true);
  let at = header.length + body.length;
  const place = (bytes: Uint8Array | null, offField: number) => {
    if (bytes) { out.set(bytes, at); view.setUint32(offField, at, true); view.setUint32(offField + 4, bytes.length, true); at += bytes.length; }
    else { view.setUint32(offField, 0, true); view.setUint32(offField + 4, 0, true); }
  };
  place(wrap.comment, 32);
  place(wrap.creatorData, 40);
  const flags = view.getUint32(16, true);
  view.setUint32(16, disk.apple2.bits.writeProtected ? (flags | TWO_IMG_LOCKED) >>> 0 : flags & ~TWO_IMG_LOCKED, true);
  return out;
}

/** Serialize a disk in the format it was loaded from, with every write in it.
 *  Call {@link foldApple2Track} for written tracks first (the Disk II does). */
export function serializeApple2Media(disk: Apple2Disk): { data: Uint8Array; ext: string } {
  const a = disk.apple2;
  switch (a.source) {
    case 'woz': {
      const w = a.woz;
      return {
        ext: '.woz',
        data: serializeWoz({
          tmap: a.bits.tmap, tracks: a.bits.tracks, bitTiming: a.bits.bitTiming,
          writeProtected: a.bits.writeProtected,
          synchronized: w?.synchronized, cleaned: w?.cleaned, creator: w?.creator || 'zx84',
          bootSectorFormat: w?.bootSectorFormat ?? 0, compatibleHardware: w?.compatibleHardware,
          requiredRam: w?.requiredRam, meta: w?.meta ?? null,
        }),
      };
    }
    case 'nib':
      return { ext: '.nib', data: toNib(a.bits, disk.numTracks) };
    case 'd13':
      return { ext: '.d13', data: serializeApple2Disk13(disk) };
    case '2mg': {
      const nibbles = a.twoImg?.format === 2;
      const body = nibbles ? toNib(a.bits, disk.numTracks) : serializeApple2Disk(disk, a.order);
      return { ext: '.2mg', data: twoImgBytes(disk, body) };
    }
    default:
      return { ext: a.order === 'prodos' ? '.po' : '.dsk', data: serializeApple2Disk(disk, a.order) };
  }
}
