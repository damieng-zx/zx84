/**
 * Recording density and per-sector marks at the controllers.
 *
 * WD1770/1772 family: the /DDEN pin selects FM (single density) or MFM (double
 * density); in the other density the data separator never finds an address
 * mark, so the track reads as unformatted (RECORD NOT FOUND), and WRITE TRACK
 * lays down the density the pin selects.
 *
 * Intel 8271: an FM-only controller. Its completion code has bit 5 set when a
 * deleted-data mark was read ("deleted data found") and is 0x0E for a data CRC
 * error; WRITE DELETED DATA lays a deleted-data mark down.
 */

import { describe, it, expect } from 'vitest';
import { WD179x } from '@/cores/wd179x.ts';
import { I8271, I8271Result } from '@/cores/i8271.ts';
import type { DskImage, DskSector, DskTrack } from '@/media/floppy/disk-image.ts';

const ST_RNF = 0x10;
const ST_DRQ = 0x02;

function image(encoding: DskTrack['encoding'], sectors: DskSector[]): DskImage {
  const track: DskTrack = {
    sectors, sectorMap: new Map(sectors.map((s, i) => [s.r, i])), gap3: 16, filler: 0xE5, encoding,
  };
  return { format: 'standard', numTracks: 1, numSides: 1, tracks: [[track]], diskFormat: '', protection: '' };
}

const sec = (r: number, fill: number, st2 = 0, st1 = 0): DskSector =>
  ({ c: 0, h: 0, r, n: 1, st1, st2, data: new Uint8Array(256).fill(fill) });

describe('WD1770 /DDEN', () => {
  function readSector1(wd: WD179x): number {
    wd.sectorReg = 1;
    wd.writeCommand(0x80);
    return wd.readStatus();
  }

  it('cannot read a single-density track in double density, and can in single density', () => {
    const wd = new WD179x({ statusBit7: 'motor-on', formatSectorsPerTrack: 10 });
    wd.insertDisk(image('fm', [sec(1, 0x42)]), 0);
    expect(readSector1(wd) & ST_RNF).toBe(ST_RNF);
    wd.setDensity(true);
    expect(readSector1(wd) & (ST_RNF | ST_DRQ)).toBe(ST_DRQ);
    expect(wd.readData()).toBe(0x42);
  });

  it('cannot read a double-density track in single density', () => {
    const wd = new WD179x({ statusBit7: 'motor-on', formatSectorsPerTrack: 10 });
    wd.insertDisk(image('mfm', [sec(1, 0x42)]), 0);
    wd.setDensity(true);
    expect(readSector1(wd) & ST_RNF).toBe(ST_RNF);
    wd.setDensity(false);
    expect(readSector1(wd) & ST_DRQ).toBe(ST_DRQ);
  });

  it('reads a track of unrecorded density in either', () => {
    const wd = new WD179x({ statusBit7: 'motor-on', formatSectorsPerTrack: 10 });
    wd.insertDisk(image(undefined, [sec(1, 0x42)]), 0);
    expect(readSector1(wd) & ST_DRQ).toBe(ST_DRQ);
    wd.reset();
    wd.setDensity(true);
    expect(readSector1(wd) & ST_DRQ).toBe(ST_DRQ);
  });

  it('keeps the density across a chip reset (it is a pin, not a register)', () => {
    const wd = new WD179x({ statusBit7: 'motor-on', formatSectorsPerTrack: 10 });
    wd.setDensity(true);
    wd.reset();
    expect(wd.singleDensity).toBe(true);
  });

  it('lays down the selected density with WRITE TRACK', () => {
    const wd = new WD179x({ statusBit7: 'motor-on', formatSectorsPerTrack: 1 });
    const img = image('mfm', [sec(1, 0)]);
    wd.insertDisk(img, 0);
    wd.setDensity(true);
    wd.writeCommand(0xF0);
    for (const b of [0xFF, 0x00, 0xFE, 0, 0, 5, 1, 0xF7, 0xFF, 0x00, 0xFB]) wd.writeData(b);
    for (let i = 0; i < 256; i++) wd.writeData(0xE5);
    const t = img.tracks[0][0]!;
    expect(t.encoding).toBe('fm');
    expect(t.sectors.map(s => s.r)).toEqual([5]);
  });
});

describe('Intel 8271 recording and marks', () => {
  function send(fdc: I8271, cmd: number, ...params: number[]): void {
    fdc.write(0, cmd);
    for (const p of params) fdc.write(1, p);
  }
  const step = (fdc: I8271): void => { for (let i = 0; i < 3; i++) fdc.tick(200); };

  function chip(img: DskImage): I8271 {
    const fdc = new I8271();
    fdc.insertDisk(img, 0);
    send(fdc, 0x3a, 0x17, 0xc1);           // non-DMA mode
    send(fdc, 0x3a, 0x23, 0x48);           // drive 0, side 0
    return fdc;
  }

  /** READ DATA (0x13) of `count` 256-byte sectors from sector `r`; the bytes
   *  transferred and the result. */
  function read(fdc: I8271, r: number, count: number): { bytes: number[]; result: number } {
    send(fdc, 0x13, 0x00, r, 0x20 | count);
    const bytes: number[] = [];
    for (let i = 0; i < 256 * count; i++) {
      step(fdc);
      if ((fdc.read(0) & 0x04) === 0) break;          // no data request: the transfer ended
      bytes.push(fdc.readData());
    }
    step(fdc);
    return { bytes, result: fdc.read(1) };
  }

  it('finds no sector on a double-density track', () => {
    expect(read(chip(image('mfm', [sec(0, 1)])), 0, 1).result).toBe(I8271Result.NF);
  });

  it('reads a single-density track and one of unrecorded density', () => {
    expect(read(chip(image('fm', [sec(0, 1)])), 0, 1).result).toBe(I8271Result.NONE);
    expect(read(chip(image(undefined, [sec(0, 1)])), 0, 1).result).toBe(I8271Result.NONE);
  });

  it('stops after a deleted-data sector and reports deleted data found (bit 5)', () => {
    const out = read(chip(image('fm', [sec(0, 0x11, 0x40), sec(1, 0x22)])), 0, 2);
    expect(out.result).toBe(0x20);
    expect(out.bytes.length).toBe(256);
    expect(out.bytes[0]).toBe(0x11);
  });

  it('reports a data CRC error (0x0E) after transferring the sector', () => {
    const out = read(chip(image('fm', [sec(0, 0x11), sec(1, 0x22, 0x20, 0x20), sec(2, 0x33)])), 0, 3);
    expect(out.result).toBe(0x0E);
    expect(out.bytes.length).toBe(512);
    expect(out.bytes[256]).toBe(0x22);
  });

  it('lays down a deleted-data mark with WRITE DELETED DATA and a normal one with WRITE DATA', () => {
    const img = image('fm', [sec(0, 0), sec(1, 0, 0x40)]);
    const fdc = chip(img);
    send(fdc, 0x0f, 0x00, 0x00, 0x21);      // WRITE DELETED DATA, sector 0
    for (let i = 0; i < 256; i++) { step(fdc); fdc.writeData(0x5A); }
    step(fdc);
    expect(fdc.read(1)).toBe(I8271Result.NONE);
    send(fdc, 0x0b, 0x00, 0x01, 0x21);      // WRITE DATA, sector 1
    for (let i = 0; i < 256; i++) { step(fdc); fdc.writeData(0xA5); }
    step(fdc);
    fdc.read(1);
    const [s0, s1] = img.tracks[0][0]!.sectors;
    expect(s0.st2).toBe(0x40);
    expect(s0.data[0]).toBe(0x5A);
    expect(s1.st2).toBe(0);
  });

  it('reads a weak sector as one of its recorded readings', () => {
    const weak = sec(0, 0x11, 0x20, 0x20);
    weak.copies = [new Uint8Array(256).fill(0x11), new Uint8Array(256).fill(0x99)];
    const fdc = chip(image('fm', [weak]));
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) seen.add(read(fdc, 0, 1).bytes[0]);
    expect([...seen].sort((a, b) => a - b)).toEqual([0x11, 0x99]);
  });
});
