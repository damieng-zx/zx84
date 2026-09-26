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

  it('hides the drives when no disc interface is fitted', () => {
    const m = new BbcMachine('bbc-b', null);
    try {
      expect(m.services.disks!.drives.length).toBe(2);
      m.setDiskSystem('none');
      expect(m.services.disks!.drives.length).toBe(0);
      m.setDiskSystem('1770');
      expect(m.services.disks!.drives.length).toBe(2);
    } finally {
      m.destroy();
    }
  });

  it('exposes the disc-interface ROM as socket 13 when a controller is fitted', () => {
    const m = new BbcMachine('bbc-b', null);
    try {
      const slots = m.services.roms.sidewaysSlots!;
      expect(slots.length).toBe(16);
      expect(slots[13].title).toBe('Disc interface ROM');
      expect(slots[13].label).toBe('Acorn 1770 DFS');
      m.setDiskSystem('acorn');
      expect(m.services.roms.sidewaysSlots![13].label).toBe('Acorn DFS (8271)');
      m.setDiskSystem('none');
      expect(m.services.roms.sidewaysSlots![13].label).toBe('');
    } finally {
      m.destroy();
    }
  });

  it('mirrors an 8K sideways ROM across both halves of the 16K socket', () => {
    const m = new BbcMachine('bbc-b', null);
    try {
      const rom = Uint8Array.from({ length: 0x2000 }, (_, i) => (i * 7) & 0xFF);
      m.services.roms.installSidewaysRom!(2, rom);
      const socket = m.memory.roms[2];
      expect(socket.length).toBe(0x4000);
      expect(socket[0x0000]).toBe(0x00);
      expect(socket[0x0001]).toBe(0x07);
      // The second half repeats the image (A13 not connected on an 8K part).
      expect(Array.from(socket.subarray(0x2000, 0x2004))).toEqual(Array.from(socket.subarray(0, 4)));
    } finally {
      m.destroy();
    }
  });

  it('routes the floppy window to the 8271 when it is the selected controller', () => {
    const m = new BbcMachine('bbc-b', null);
    try {
      m.setDiskSystem('acorn');
      // READ DRIVE STATUS takes no parameters, so it completes immediately:
      // the status register shows result-ready (0x10) but, being a simple
      // command, no interrupt (0x08).
      m.memory.writeByte(0xFE80, 0x2c);
      expect(m.memory.readByte(0xFE80) & 0x18).toBe(0x10);
      m.memory.readByte(0xFE81);                       // consume the result
      expect(m.memory.readByte(0xFE80) & 0x18).toBe(0);
    } finally {
      m.destroy();
    }
  });
});
