/**
 * Lossless snapshot encoding of the shared floppy model (`DskImage`).
 *
 * A machine snapshot carries its mounted disks exactly as the FDC sees them —
 * every track's sectors in physical order, their CHRN and status bytes, weak
 * sector copies, the R → index map (which need not be the obvious one when a
 * track repeats an R), and an HFE bitstream when the disk came from one — so a
 * restore reads the same bytes, errors and protection quirks as the original.
 * It is not a disk file format; an image is saved for other tools through each
 * machine's own DSK/HFE writers.
 *
 * Written against the neutral `StateSink`/`StateSource` stream so the FDC
 * cores can use the same encoding for a sector caught mid-format.
 */

import type { StateSink, StateSource } from '@/utils/state-stream.ts';
import type {
  DskImage, DskSector, DskTrack, HfeBitstream, HfeSectorLayout,
} from './disk-image.ts';

/** Largest track/side counts accepted when reading, against a corrupt count. */
const MAX_CYLINDERS = 256;
const MAX_SIDES = 2;
const MAX_SECTORS = 256;
const MAX_COPIES = 64;
const MAX_SECTOR_BYTES = 0x10000;

export function writeDskSector(w: StateSink, s: DskSector): void {
  w.u8(s.c); w.u8(s.h); w.u8(s.r); w.u8(s.n);
  w.u8(s.st1); w.u8(s.st2);
  w.bytes(s.data);
  const copies = s.copies;
  w.u16(copies ? copies.length : 0);
  if (copies) {
    for (const c of copies) {
      // copies[0] is normally the same array as `data`; keep that sharing.
      w.bool(c === s.data);
      if (c !== s.data) w.bytes(c);
    }
  }
}

export function readDskSector(r: StateSource): DskSector {
  const c = r.u8(), h = r.u8(), rr = r.u8(), n = r.u8();
  const st1 = r.u8(), st2 = r.u8();
  const data = r.bytes(MAX_SECTOR_BYTES);
  const sector: DskSector = { c, h, r: rr, n, st1, st2, data };
  const count = r.u16();
  if (count > MAX_COPIES) throw new Error('Snapshot is corrupt (sector copies)');
  if (count > 0) {
    const copies: Uint8Array[] = [];
    for (let i = 0; i < count; i++) copies.push(r.bool() ? data : r.bytes(MAX_SECTOR_BYTES));
    sector.copies = copies;
  }
  return sector;
}

function writeTrack(w: StateSink, t: DskTrack): void {
  w.u16(t.sectors.length);
  for (const s of t.sectors) writeDskSector(w, s);
  w.u16(t.sectorMap.size);
  for (const [r, i] of t.sectorMap) { w.u16(r); w.u16(i); }
  w.u8(t.gap3); w.u8(t.filler);
  w.u8(t.encoding === 'fm' ? 1 : t.encoding === 'mfm' ? 2 : 0);
}

function readTrack(r: StateSource): DskTrack {
  const n = r.u16();
  if (n > MAX_SECTORS) throw new Error('Snapshot is corrupt (sector count)');
  const sectors: DskSector[] = [];
  for (let i = 0; i < n; i++) sectors.push(readDskSector(r));
  const sectorMap = new Map<number, number>();
  const entries = r.u16();
  if (entries > MAX_SECTORS) throw new Error('Snapshot is corrupt (sector map)');
  for (let i = 0; i < entries; i++) {
    const rr = r.u16();
    const idx = r.u16();
    if (idx >= sectors.length) throw new Error('Snapshot is corrupt (sector map)');
    sectorMap.set(rr, idx);
  }
  const track: DskTrack = { sectors, sectorMap, gap3: r.u8(), filler: r.u8() };
  const encoding = r.u8();
  if (encoding === 1) track.encoding = 'fm';
  else if (encoding === 2) track.encoding = 'mfm';
  return track;
}

function writeBitstream(w: StateSink, b: HfeBitstream): void {
  w.u16(b.cells.length);
  for (let cyl = 0; cyl < b.cells.length; cyl++) {
    const sides = b.cells[cyl] ?? [];
    const layouts = b.layout[cyl] ?? [];
    const n = Math.max(sides.length, layouts.length);
    w.u8(n);
    for (let side = 0; side < n; side++) {
      const cells = sides[side] ?? null;
      w.bool(cells !== null);
      if (cells) w.bytes(cells);
      const layout = layouts[side] ?? null;
      w.bool(layout !== null);
      if (layout) {
        w.u16(layout.length);
        for (const l of layout) { w.u32(l.dataBit); w.u32(l.len); w.u8(l.mark); w.u8(l.fm ?? 0); }
      }
    }
  }
}

function readBitstream(r: StateSource): HfeBitstream {
  const cyls = r.u16();
  if (cyls > MAX_CYLINDERS) throw new Error('Snapshot is corrupt (bitstream)');
  const cells: (Uint8Array | null)[][] = [];
  const layout: (HfeSectorLayout[] | null)[][] = [];
  for (let cyl = 0; cyl < cyls; cyl++) {
    const n = r.u8();
    if (n > MAX_SIDES) throw new Error('Snapshot is corrupt (bitstream)');
    const sideCells: (Uint8Array | null)[] = [];
    const sideLayout: (HfeSectorLayout[] | null)[] = [];
    for (let side = 0; side < n; side++) {
      sideCells.push(r.bool() ? r.bytes(1 << 20) : null);
      if (r.bool()) {
        const count = r.u16();
        if (count > MAX_SECTORS) throw new Error('Snapshot is corrupt (bitstream)');
        const list: HfeSectorLayout[] = [];
        for (let i = 0; i < count; i++) {
          const entry: HfeSectorLayout = { dataBit: r.u32(), len: r.u32(), mark: r.u8() };
          const fm = r.u8();
          if (fm) entry.fm = fm;
          list.push(entry);
        }
        sideLayout.push(list);
      } else {
        sideLayout.push(null);
      }
    }
    cells.push(sideCells);
    layout.push(sideLayout);
  }
  return { cells, layout };
}

/** Write a whole disk image. */
export function writeDskImage(w: StateSink, img: DskImage): void {
  w.str(img.format);
  w.u16(img.numTracks); w.u8(img.numSides);
  w.str(img.diskFormat); w.str(img.protection);
  w.bool(img.flippy === true);
  w.u16(img.tracks.length);
  for (const sides of img.tracks) {
    const list = sides ?? [];
    w.u8(list.length);
    for (const t of list) {
      w.bool(!!t);
      if (t) writeTrack(w, t);
    }
  }
  w.bool(img.bitstream !== undefined);
  if (img.bitstream) writeBitstream(w, img.bitstream);
}

/** Read a disk image written by {@link writeDskImage}. */
export function readDskImage(r: StateSource): DskImage {
  const format = r.str();
  if (format !== 'standard' && format !== 'extended') throw new Error('Snapshot is corrupt (disk format)');
  const numTracks = r.u16(), numSides = r.u8();
  const diskFormat = r.str(), protection = r.str();
  const flippy = r.bool();
  const cyls = r.u16();
  if (cyls > MAX_CYLINDERS) throw new Error('Snapshot is corrupt (track count)');
  const tracks: (DskTrack | null)[][] = [];
  for (let cyl = 0; cyl < cyls; cyl++) {
    const n = r.u8();
    if (n > MAX_SIDES) throw new Error('Snapshot is corrupt (side count)');
    const sides: (DskTrack | null)[] = [];
    for (let side = 0; side < n; side++) sides.push(r.bool() ? readTrack(r) : null);
    tracks.push(sides);
  }
  const img: DskImage = { format, numTracks, numSides, tracks, diskFormat, protection };
  if (flippy) img.flippy = true;
  if (r.bool()) img.bitstream = readBitstream(r);
  return img;
}

/** Where `track` sits in `img` as [cylinder, side], or null. For an FDC that
 *  holds a reference to the track it is working on. */
export function locateTrack(img: DskImage | null, track: DskTrack | null): [number, number] | null {
  if (!img || !track) return null;
  for (let cyl = 0; cyl < img.tracks.length; cyl++) {
    const sides = img.tracks[cyl];
    if (!sides) continue;
    for (let side = 0; side < sides.length; side++) if (sides[side] === track) return [cyl, side];
  }
  return null;
}

/** The track at [cylinder, side] of `img`, or null. */
export function trackAt(img: DskImage | null, cyl: number, side: number): DskTrack | null {
  return img?.tracks[cyl]?.[side] ?? null;
}
