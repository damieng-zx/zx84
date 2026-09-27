/**
 * BBC DFS tests: the SSD/DSD codec and the Acorn 1770 interface wired through
 * the machine's memory bus.
 */

import { describe, it, expect } from 'vitest';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { BbcDfs1770 } from '@/machines/bbc/peripherals/wd1770-dfs.ts';
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
      // The disc-interface ROM and language ROM are listed first.
      expect(slots[0].index).toBe(13);
      expect(slots[0].title).toBe('Disc interface ROM');
      expect(slots[0].label).toBe('Acorn 1770 DFS');
      expect(slots[1].index).toBe(15);
      expect(slots[1].title).toBe('Language ROM (BASIC)');
      const at13 = () => m.services.roms.sidewaysSlots!.find(s => s.index === 13)!;
      m.setDiskSystem('acorn');
      expect(at13().label).toBe('Acorn DFS (8271)');
      m.setDiskSystem('none');
      expect(at13().label).toBe('');
      // With no disc interface fitted the language ROM still leads.
      expect(m.services.roms.sidewaysSlots![0].index).toBe(15);
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

  it('reads a file sector across a track boundary after a STEP (Citadel 2 layout)', () => {
    // Citadel 2's `CitBits` file runs from LBA 137 to 142, so the DFS reads
    // track 13 sectors 7-9 and then STEPs onto track 14 to read sectors 0-2.
    // Pin that sequence: the track register must follow the head so the ID
    // search accepts track 14's sectors.
    const m = new BbcMachine('bbc-b', null);
    try {
      const ssd = new Uint8Array(SSD_TRACK_BYTES * 80);
      for (let t = 0; t < 80; t++) {
        for (let r = 0; r < SPT; r++) {
          for (let b = 0; b < SECTOR; b++) {
            ssd[t * SSD_TRACK_BYTES + r * SECTOR + b] = (t * SPT + r + b) & 0xff;
          }
        }
      }
      m.fdc1770.insertDisk(parseSsd(ssd, false), 0);
      m.memory.writeByte(0xFE80, 0x20);      // drive 0, side 0, reset released
      m.memory.writeByte(0xFE87, 13);        // SEEK target
      m.memory.writeByte(0xFE84, 0x10);      // SEEK
      expect(m.memory.readByte(0xFE85)).toBe(13);
      m.memory.writeByte(0xFE86, 9);
      m.memory.writeByte(0xFE84, 0x80);      // READ SECTOR track 13 sector 9
      for (let i = 0; i < SECTOR; i++) m.memory.readByte(0xFE87);
      m.fdc1770.tick(0x1000);                // completion edge on the disc clock
      m.memory.writeByte(0xFE84, 0x50);      // STEP IN with track-register update
      expect(m.memory.readByte(0xFE85)).toBe(14);
      m.memory.writeByte(0xFE86, 2);
      m.memory.writeByte(0xFE84, 0x80);      // READ SECTOR track 14 sector 2
      const got: number[] = [];
      for (let i = 0; i < SECTOR; i++) got.push(m.memory.readByte(0xFE87));
      expect(got[0]).toBe((14 * SPT + 2) & 0xff);
      expect(got[SECTOR - 1]).toBe((14 * SPT + 2 + SECTOR - 1) & 0xff);
    } finally {
      m.destroy();
    }
  });
});

/**
 * The Acorn 1770 disc interface wires the controller's DRQ and command
 * completion to the CPU's NMI line; Acorn DFS transfers each sector byte from
 * an NMI handler. These tests pin that handshake at the peripheral boundary.
 */
describe('bbc 1770 Acorn NMI handshake', () => {
  function disc(nmis: number[]): BbcDfs1770 {
    return new BbcDfs1770((asserted) => { if (asserted) nmis.push(1); });
  }

  it('floats the write-only drive-control latch high (DFS presence probe)', () => {
    const d = disc([]);
    expect(d.read(0x80)).toBe(0xFF);
    d.write(0x80, 0x25);                 // a real write must not echo back
    expect(d.read(0x80)).toBe(0xFF);
  });

  it('selects the drive from bit 1 of the control latch', () => {
    const d = disc([]);
    d.write(0x80, 0x29);                 // bit 1 clear -> drive 0
    expect(d.currentDrive).toBe(0);
    d.write(0x80, 0x2A);                 // bit 1 set -> drive 1
    expect(d.currentDrive).toBe(1);
  });

  it('resets the controller while the latch reset bit is held low', () => {
    const d = disc([]);
    d.write(0x80, 0x20);                 // reset released (active low)
    d.write(0x85, 0x2A);
    expect(d.read(0x85)).toBe(0x2A);
    d.write(0x80, 0x00);                 // assert reset
    expect(d.read(0x85)).toBe(0x00);
    d.write(0x85, 0x2A);
    d.write(0x80, 0x20);                 // release; must not reset again
    expect(d.read(0x85)).toBe(0x2A);
  });

  it('raises an NMI for every transferred byte, then one on completion', () => {
    const nmis: number[] = [];
    const d = disc(nmis);
    d.insertDisk(parseSsd(makeSsdPattern(), false), 0);
    d.write(0x80, 0x20);                 // drive 0, side 0, reset released
    d.write(0x85, 0x00);                 // track 0
    d.write(0x86, 0x03);                 // sector 3
    d.write(0x84, 0x80);                 // READ SECTOR
    // The first byte is offered on the disc clock, so no edge has fired yet.
    expect(nmis.length).toBe(0);
    d.tick(0x1000);
    expect(nmis.length).toBe(1);

    const got: number[] = [];
    for (let i = 0; i < SECTOR; i++) {
      expect(d.read(0x84) & 0x03).toBe(0x03);   // BUSY | DRQ while transferring
      got.push(d.read(0x87));
      d.tick(0x1000);
    }
    expect(got[0]).toBe(0);              // makeSsdPattern: sector 3 byte i = i
    expect(got[255]).toBe(255);
    // One edge per byte plus one completion edge.
    expect(nmis.length).toBe(SECTOR + 1);
    expect(d.read(0x84) & 0x01).toBe(0); // BUSY clear after completion
  });

  it('raises a completion NMI for a Type I command', () => {
    const nmis: number[] = [];
    const d = disc(nmis);
    d.insertDisk(parseSsd(makeSsdPattern(), false), 0);
    d.write(0x80, 0x20);
    d.write(0x84, 0x00);                 // RESTORE
    expect(nmis.length).toBe(0);         // the edge is raised on the disc clock
    d.tick(0x1000);
    expect(nmis.length).toBe(1);
    expect(d.read(0x84) & 0x01).toBe(0); // not busy
  });
});
