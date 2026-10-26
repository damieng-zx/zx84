/**
 * A mounted Apple II disk (`Apple2Disk`) written into a machine snapshot and
 * read back: the sector view (media/floppy/disk-state.ts) and the bit-cell
 * tracks under the head — the quarter-track map, every track's cells as they
 * are now (a guest's writes included), the cell timing and the write-protect
 * tab — with what a save needs to write it back in its own format (source
 * format, sector layout and order, volume number, a `.2mg` wrapper, the WOZ
 * details).
 */

import type { StateSink, StateSource } from '@/utils/state-stream.ts';
import { readDskImage, writeDskImage } from './disk-state.ts';
import type { Apple2BitTrack } from './apple2-bitstream.ts';
import type {
  Apple2Disk, Apple2MediaFormat, TwoImgWrapper, WozDetails,
} from './apple2-media.ts';

const FORMATS: readonly Apple2MediaFormat[] = ['dsk', 'd13', 'nib', '2mg', 'woz'];

function writeOptionalBytes(w: StateSink, b: Uint8Array | null): void {
  w.bool(b !== null);
  if (b) w.bytes(b);
}

function readOptionalBytes(r: StateSource): Uint8Array | null {
  return r.bool() ? r.bytes(1 << 20) : null;
}

export function writeApple2Disk(w: StateSink, disk: Apple2Disk): void {
  writeDskImage(w, disk);
  const a = disk.apple2;
  w.str(a.source);
  w.u8(a.sectorsPerTrack);
  w.str(a.order);
  w.u8(a.volume);
  const bits = a.bits;
  w.bytes(bits.tmap);
  w.u16(bits.tracks.length);
  for (const t of bits.tracks) { w.u32(t.bitCount); w.bytes(t.data); }
  w.u16(bits.bitTiming);
  w.bool(bits.writeProtected);
  w.bool(a.twoImg !== null);
  if (a.twoImg) {
    w.bytes(a.twoImg.header);
    w.u32(a.twoImg.format);
    writeOptionalBytes(w, a.twoImg.comment);
    writeOptionalBytes(w, a.twoImg.creatorData);
  }
  // The WOZ details are plain fields; JSON keeps them whole.
  w.bytes(new TextEncoder().encode(a.woz ? JSON.stringify(a.woz) : ''));
}

export function readApple2Disk(r: StateSource): Apple2Disk {
  const image = readDskImage(r);
  const source = r.str() as Apple2MediaFormat;
  if (!FORMATS.includes(source)) throw new Error('Snapshot is corrupt (Apple II disk format)');
  const spt = r.u8();
  if (spt !== 13 && spt !== 16) throw new Error('Snapshot is corrupt (Apple II sectors per track)');
  const order = r.str() === 'prodos' ? 'prodos' : 'dos';
  const volume = r.u8();
  const tmap = r.bytes(1 << 10);
  const tracks: Apple2BitTrack[] = [];
  for (let n = r.u16(); n > 0; n--) {
    const bitCount = r.u32();
    const data = r.bytes(1 << 20);
    if (bitCount > data.length * 8) throw new Error('Snapshot is corrupt (Apple II bit track)');
    tracks.push({ bitCount, data });
  }
  for (const slot of tmap) {
    if (slot !== 0xFF && slot >= tracks.length) throw new Error('Snapshot is corrupt (Apple II track map)');
  }
  const bitTiming = r.u16();
  const writeProtected = r.bool();
  let twoImg: TwoImgWrapper | null = null;
  if (r.bool()) {
    const header = r.bytes(1 << 16);
    const format = r.u32();
    twoImg = { header, format, comment: readOptionalBytes(r), creatorData: readOptionalBytes(r) };
  }
  const wozJson = new TextDecoder().decode(r.bytes(1 << 20));
  const woz = wozJson === '' ? null : JSON.parse(wozJson) as WozDetails;
  const disk = image as Apple2Disk;
  disk.apple2 = {
    bits: { tmap, tracks, bitTiming, writeProtected },
    source, sectorsPerTrack: spt, order, volume, twoImg, woz,
  };
  return disk;
}
