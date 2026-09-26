/**
 * BBC DFS tests: the SSD/DSD codec and the Acorn 1770 interface wired through
 * the machine's memory bus.
 */

import { describe, it, expect } from 'vitest';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { parseSsd, serializeSsd, SSD_TRACK_BYTES } from '@/media/floppy/ssd.ts';

const SECTOR = 256;
const SPT = 10;

function makeSsdPattern(): Uint8Array {
  const data = new Uint8Array(SSD_TRACK_BYTES * 80);
  // Track 0 sector 3: byte i = i; track 1 sector 0: 0xAA.
  for (let i = 0; i < SECTOR; i++) data[3 * SECTOR + i] = i;
  data[SSD_TRACK_BYTES] = 0xAA;
  return data;
}

describe('ssd codec', () => {
  it('parses a single-sided 80-track image', () => {
    const img = parseSsd(makeSsdPattern(), false);
    expect(img.numTracks).toBe(80);
    expect(img.numSides).toBe(1);
    expect(img.tracks[0]?.[0]?.sectors.length).toBe(SPT);
    expect(Array.from(img.tracks[0]![0]!.sectors[3].data.slice(0, 4))).toEqual([0, 1, 2, 3]);
    expect(img.tracks[1]?.[0]?.sectors[0].data[0]).toBe(0xAA);
  });

  it('interleaves sides for a double-sided image', () => {
    const data = new Uint8Array(SSD_TRACK_BYTES * 160);
    data[0] = 0x11;                       // side 0, track 0, sector 0
    data[SSD_TRACK_BYTES] = 0x22;         // side 1, track 0, sector 0
    const img = parseSsd(data, true);
    expect(img.numTracks).toBe(80);
    expect(img.numSides).toBe(2);
    expect(img.tracks[0]![0]!.sectors[0].data[0]).toBe(0x11);
    expect(img.tracks[0]![1]!.sectors[0].data[0]).toBe(0x22);
  });

  it('round-trips through serialize', () => {
    const src = makeSsdPattern();
    const out = serializeSsd(parseSsd(src, false), false);
    expect(out.length).toBe(src.length);
    expect(out[3 * SECTOR + 5]).toBe(5);
    expect(out[SSD_TRACK_BYTES]).toBe(0xAA);
  });
});

describe('bbc 1770 interface', () => {
  it('reads a DFS sector through the sheila registers', () => {
    const m = new BbcMachine('bbc-b', null);
    try {
      m.fdc1770.insertDisk(parseSsd(makeSsdPattern(), false), 0);
      m.memory.writeByte(0xFE80, 0x00);   // drive 0, side 0
      m.memory.writeByte(0xFE85, 0x00);   // track 0
      m.memory.writeByte(0xFE86, 0x03);   // sector 3
      m.memory.writeByte(0xFE84, 0x80);   // READ SECTOR
      const status = m.memory.readByte(0xFE84);
      expect(status & 0x03).toBe(0x03);   // BUSY | DRQ
      const got: number[] = [];
      for (let i = 0; i < 4; i++) got.push(m.memory.readByte(0xFE87));
      expect(got).toEqual([0, 1, 2, 3]);
    } finally {
      m.destroy();
    }
  });

  it('reads back the written track/sector registers (hardware detect)', () => {
    const m = new BbcMachine('bbc-b', null);
    try {
      m.memory.writeByte(0xFE85, 0x5A);
      expect(m.memory.readByte(0xFE85)).toBe(0x5A);
      m.memory.writeByte(0xFE86, 0x5A);
      expect(m.memory.readByte(0xFE86)).toBe(0x5A);
    } finally {
      m.destroy();
    }
  });

  it('exposes two drives via the disk service', () => {
    const m = new BbcMachine('bbc-b', null);
    try {
      const drives = m.services.disks!.drives;
      expect(drives.map(d => d.id)).toEqual(['a', 'b']);
      m.services.disks!.insert('a', parseSsd(makeSsdPattern(), false), 'test.ssd');
      expect(m.services.disks!.drives.find(d => d.id === 'a')!.loaded).toBe(true);
    } finally {
      m.destroy();
    }
  });
});
