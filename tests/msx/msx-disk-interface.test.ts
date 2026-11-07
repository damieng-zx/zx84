/**
 * MSX floppy disk interface — memory-mapped WD2793 card in slot 3.
 *
 * Register map (Philips / Sony / National family): 7FF8 status/command, 7FF9
 * track, 7FFA sector, 7FFB data, 7FFC side (bit 0), 7FFD drive select (bits
 * 0-1) + motor (bit 7), 7FFF flags with DRQ on bit 6 and INTRQ on bit 7. The
 * WD2793 command set is from the datasheet: 0x00 RESTORE, 0x80 READ SECTOR,
 * 0xA0 WRITE SECTOR; Type I status bit 2 = TRACK 0, bit 7 = NOT READY.
 *
 * No real Disk BASIC ROM is available here, so end-to-end tests drive the card
 * with small hand-assembled Z80 programs.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MsxDiskInterface, detectLayout } from '@/machines/msx/peripherals/disk-interface.ts';
import { MsxMemory } from '@/machines/msx/msx-memory.ts';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';
import { blankMsxDisk, parseMsxRaw } from '@/media/floppy/msx-disk.ts';

const STATUS = 0x7FF8, TRACK = 0x7FF9, SECTOR = 0x7FFA, DATA = 0x7FFB;
const SIDE = 0x7FFC, DRIVE = 0x7FFD, FLAGS = 0x7FFF;
const DRQ = 0x40, INTRQ = 0x80;

/** A 720K disk whose sector (c,h,r) holds bytes derived from its address. */
function patternDisk() {
  const raw = new Uint8Array(1440 * 512);
  for (let l = 0; l < 1440; l++) {
    for (let i = 0; i < 512; i++) raw[l * 512 + i] = (l * 7 + i) & 0xFF;
  }
  raw[512] = 0xF9;   // FAT media descriptor
  return parseMsxRaw(raw);
}

function fitted(): MsxDiskInterface {
  const di = new MsxDiskInterface();
  const rom = new Uint8Array(0x4000).fill(0xFF);
  rom[0] = 0x41; rom[1] = 0x42;
  di.loadROM(rom);
  di.fdc.insertDisk(patternDisk(), 0);
  return di;
}

/** Drain a READ SECTOR transfer through the data register. */
function readSector(di: MsxDiskInterface, len = 512): number[] {
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    expect(di.read(FLAGS) & DRQ).toBe(DRQ);
    out.push(di.read(DATA));
  }
  return out;
}

describe('MsxDiskInterface registers', () => {
  it('serves the ROM below the register window and shadows it above', () => {
    const di = new MsxDiskInterface();
    const rom = new Uint8Array(0x4000);
    for (let i = 0; i < rom.length; i++) rom[i] = (i * 3) & 0xFF;
    di.loadROM(rom);
    expect(di.read(0x4000)).toBe(rom[0]);
    expect(di.read(0x7FF7)).toBe(rom[0x3FF7]);
    di.write(TRACK, 0x42);
    expect(di.read(TRACK)).toBe(0x42);   // not rom[0x3FF9]
    expect(di.peek(0x4005)).toBe(rom[5]);
  });

  it('ignores writes into the ROM body', () => {
    const di = fitted();
    di.write(0x4000, 0x00);
    di.write(0x7000, 0x00);
    expect(di.read(0x4000)).toBe(0x41);
  });

  it('keeps track and sector registers', () => {
    const di = fitted();
    di.write(TRACK, 0x11);
    di.write(SECTOR, 0x05);
    expect(di.read(TRACK)).toBe(0x11);
    expect(di.read(SECTOR)).toBe(0x05);
  });

  it('RESTORE with a disk in the drive reports TRACK 0 and READY', () => {
    const di = fitted();
    di.write(DRIVE, 0x80);
    di.write(STATUS, 0x00);
    const st = di.read(STATUS);
    expect(st & 0x04).toBe(0x04);   // track 0
    expect(st & 0x80).toBe(0);      // ready (bit 7 = not ready)
    expect(st & 0x01).toBe(0);      // not busy
  });

  it('reports NOT READY for an empty drive', () => {
    const di = fitted();
    di.write(DRIVE, 0x81);          // drive B has no disk
    di.write(STATUS, 0x00);
    expect(di.read(STATUS) & 0x80).toBe(0x80);
  });

  it('raises INTRQ when a Type I command finishes and drops it on a status read', () => {
    const di = fitted();
    di.write(STATUS, 0x00);
    expect(di.read(FLAGS) & INTRQ).toBe(INTRQ);
    di.read(STATUS);
    expect(di.read(FLAGS) & INTRQ).toBe(0);
  });

  it('READ SECTOR streams 512 bytes with DRQ, then ends with INTRQ and no DRQ', () => {
    const di = fitted();
    di.write(DRIVE, 0x80);
    di.write(STATUS, 0x00);                 // restore
    di.write(SECTOR, 3);
    di.write(STATUS, 0x80);                 // read sector
    expect(di.read(FLAGS) & INTRQ).toBe(0); // busy: no completion yet
    // Cylinder 0, head 0, sector 3 = logical sector 2.
    const expected = Array.from({ length: 512 }, (_, i) => (2 * 7 + i) & 0xFF);
    expect(readSector(di)).toEqual(expected);
    const flags = di.read(FLAGS);
    expect(flags & DRQ).toBe(0);
    expect(flags & INTRQ).toBe(INTRQ);
    expect(di.read(STATUS) & 0x01).toBe(0);
  });

  it('selects the second head from the side latch', () => {
    const di = fitted();
    di.write(DRIVE, 0x80);
    di.write(STATUS, 0x00);
    di.write(SIDE, 1);
    di.write(SECTOR, 1);
    di.write(STATUS, 0x80);
    // Cylinder 0, head 1, sector 1 = logical sector 9.
    expect(readSector(di)[0]).toBe((9 * 7) & 0xFF);
  });

  it('seeks to a track and reads there', () => {
    const di = fitted();
    di.write(DRIVE, 0x80);
    di.write(STATUS, 0x00);
    di.write(DATA, 4);
    di.write(STATUS, 0x10);                 // SEEK to track 4
    expect(di.read(TRACK)).toBe(4);
    di.write(SECTOR, 2);
    di.write(STATUS, 0x80);
    // Cylinder 4, head 0, sector 2 = logical (4*2+0)*9 + 1 = 73.
    expect(readSector(di)[0]).toBe((73 * 7) & 0xFF);
  });

  it('reports record-not-found for a sector number that does not exist', () => {
    const di = fitted();
    di.write(DRIVE, 0x80);
    di.write(STATUS, 0x00);
    di.write(SECTOR, 10);                   // tracks hold 1..9
    di.write(STATUS, 0x80);
    expect(di.read(STATUS) & 0x10).toBe(0x10);
  });

  it('WRITE SECTOR changes the image and marks the drive dirty', () => {
    const di = fitted();
    di.write(DRIVE, 0x80);
    di.write(STATUS, 0x00);
    di.write(SECTOR, 1);
    di.write(STATUS, 0xA0);
    expect(di.read(FLAGS) & DRQ).toBe(DRQ);
    for (let i = 0; i < 512; i++) di.write(DATA, 0xC0 ^ (i & 0xFF));
    expect(di.read(FLAGS) & INTRQ).toBe(INTRQ);
    const sec = di.fdc.getDiskImage(0)!.tracks[0][0]!.sectors[0];
    expect(sec.data[0]).toBe(0xC0);
    expect(sec.data[1]).toBe(0xC1);
    expect(di.fdc.isDirty(0)).toBe(true);
  });

  it('refuses to write a write-protected disk', () => {
    const di = fitted();
    di.fdc.writeProtect[0] = true;
    di.write(DRIVE, 0x80);
    di.write(STATUS, 0x00);
    di.write(SECTOR, 1);
    di.write(STATUS, 0xA0);
    expect(di.read(STATUS) & 0x40).toBe(0x40);
    expect(di.read(FLAGS) & DRQ).toBe(0);
  });

  it('decodes drive select and the motor bit', () => {
    const di = fitted();
    di.write(DRIVE, 0x00);
    expect([di.selectedDrive, di.motorOn]).toEqual([0, false]);
    di.write(DRIVE, 0x81);
    expect([di.selectedDrive, di.motorOn]).toEqual([1, true]);
    di.write(DRIVE, 0x00);
    expect(di.motorOn).toBe(false);
  });

  it('selecting drive value 3 (idle) addresses no drive', () => {
    const di = fitted();
    di.write(DRIVE, 0x03);
    di.write(STATUS, 0x00);
    expect(di.read(STATUS) & 0x80).toBe(0x80);
    expect(di.selectedUnit).toBe(3);
  });

  it('reset clears the latches and any pending INTRQ', () => {
    const di = fitted();
    di.write(DRIVE, 0x81);
    di.write(SIDE, 1);
    di.write(STATUS, 0x00);
    di.reset();
    expect([di.selectedDrive, di.selectedSide, di.motorOn]).toEqual([0, 0, false]);
    expect(di.read(FLAGS) & INTRQ).toBe(0);
  });
});

describe('compact (7FBx) register family', () => {
  function compact(): MsxDiskInterface {
    const di = fitted();
    di.setLayout('compact');
    return di;
  }

  it('maps the controller at 7FB8 and keeps ROM at 7FF8', () => {
    const di = compact();
    di.write(0x7FB9, 0x21);
    expect(di.read(0x7FB9)).toBe(0x21);
    expect(di.read(0x7FF8)).toBe(0xFF);   // ROM filler, no longer a register
  });

  it('packs one-hot drive select (bits 0-1), side (bit 2) and motor (bit 3) into 7FBC', () => {
    const di = compact();
    di.write(0x7FBC, 0b1101);              // bit 0 = drive A, side 1, motor
    expect([di.selectedUnit, di.selectedSide, di.motorOn]).toEqual([0, 1, true]);
    di.write(0x7FBC, 0b1010);              // bit 1 = drive B, side 0, motor
    expect([di.selectedUnit, di.selectedSide, di.motorOn]).toEqual([1, 0, true]);
    di.write(0x7FBC, 0b0000);              // nothing selected, motor off
    expect([di.selectedUnit, di.motorOn]).toEqual([3, false]);
  });

  it('a drive-select value with no bit set leaves the chip with a not-ready drive', () => {
    const di = compact();
    di.write(0x7FBC, 0x09);                // drive A + motor
    di.write(0x7FB8, 0x00);
    expect(di.read(0x7FB8) & 0x80).toBe(0);
    di.write(0x7FBC, 0x08);                // motor, no drive
    di.write(0x7FB8, 0x00);
    expect(di.read(0x7FB8) & 0x80).toBe(0x80);
  });

  it('reads a sector from drive A when bit 0 selects it', () => {
    const di = compact();
    di.write(0x7FBC, 0x09);
    di.write(0x7FB8, 0x00);
    di.write(0x7FBA, 2);
    di.write(0x7FB8, 0x80);
    expect(di.read(0x7FBC) & DRQ).toBe(0);
    expect(di.read(0x7FBB)).toBe(0xF9);             // logical sector 1 starts with the FAT media byte
  });

  it('reads INTRQ (high) and an inverted DRQ (bit 6 low = data waiting) from 7FBC', () => {
    const di = compact();
    di.write(0x7FBC, 0x09);
    di.write(0x7FB8, 0x00);
    expect(di.read(0x7FBC)).toBe(0xFF);            // idle, command done: INTRQ, no DRQ
    di.write(0x7FBA, 1);
    di.write(0x7FB8, 0x80);
    expect(di.read(0x7FBC) & INTRQ).toBe(0);       // busy
    expect(di.read(0x7FBC) & DRQ).toBe(0);         // data waiting: bit 6 low
  });
});

describe('register family detection', () => {
  const rom = (...words: number[]) => {
    const r = new Uint8Array(0x4000).fill(0);
    words.forEach((w, i) => { r[0x100 + i * 3] = 0x21; r[0x101 + i * 3] = w & 0xFF; r[0x102 + i * 3] = w >> 8; });   // LD HL,nnnn
    return r;
  };
  it('picks the standard layout for 7FF8-based code', () => {
    expect(detectLayout(rom(0x7FF8, 0x7FFB, 0x7FFF))).toBe('standard');
  });
  it('picks the compact layout for 7FB8-based code', () => {
    expect(detectLayout(rom(0x7FB8, 0x7FBB, 0x7FBC))).toBe('compact');
  });
  it('defaults to standard when the ROM names neither', () => {
    expect(detectLayout(rom())).toBe('standard');
  });
});

describe('slot 3 mapping', () => {
  const SLOT3_PAGE1 = 0b10_10_11_00;   // page1 = slot 3, pages 2/3 = RAM, page 0 = slot 0

  function memory(withCard: boolean): { mem: MsxMemory; di: MsxDiskInterface } {
    const mem = new MsxMemory();
    mem.loadROM(new Uint8Array(0x8000).fill(0x11));
    const di = fitted();
    di.fdc.insertDisk(patternDisk(), 0);
    if (withCard) mem.setDiskInterface(di);
    mem.setPrimarySlots(SLOT3_PAGE1);
    return { mem, di };
  }

  it('shows an empty slot (0xFF) until the interface is fitted', () => {
    const { mem } = memory(false);
    expect(mem.readByte(0x4000)).toBe(0xFF);
    expect(mem.readByte(0x7FF8)).toBe(0xFF);
  });

  it('exposes the Disk BASIC ROM at 0x4000 once fitted', () => {
    const { mem } = memory(true);
    expect(mem.readByte(0x4000)).toBe(0x41);
    expect(mem.readByte(0x4001)).toBe(0x42);
    expect(mem.readByte(0x7000)).toBe(0xFF);   // ROM filler
  });

  it('routes CPU accesses in the register window to the controller', () => {
    const { mem } = memory(true);
    mem.writeByte(DRIVE, 0x80);
    mem.writeByte(STATUS, 0x00);
    expect(mem.readByte(STATUS) & 0x04).toBe(0x04);
    mem.writeByte(TRACK, 0x33);
    expect(mem.readByte(TRACK)).toBe(0x33);
  });

  it('does not pop the data register when the debugger peeks', () => {
    const { mem, di } = memory(true);
    mem.writeByte(DRIVE, 0x80);
    mem.writeByte(STATUS, 0x00);
    mem.writeByte(SECTOR, 1);
    mem.writeByte(STATUS, 0x80);
    mem.peekByte(DATA);
    mem.readBlock(0x7FF8, 8);
    mem.snapshot();
    expect(di.read(FLAGS) & DRQ).toBe(DRQ);
    expect(mem.readByte(DATA)).toBe(0x00);       // first byte of logical sector 0
    expect(mem.readByte(DATA)).toBe(0x01);       // second: nothing was consumed early
  });

  it('only the page selecting slot 3 sees the card', () => {
    const { mem } = memory(true);
    mem.setPrimarySlots(0b10_10_00_00);          // page 1 back to slot 0 (BIOS ROM)
    expect(mem.readByte(0x4000)).toBe(0x11);
    mem.setPrimarySlots(0b10_10_10_00);          // page 1 = RAM
    mem.writeByte(0x7FF9, 0x77);
    expect(mem.readByte(0x7FF9)).toBe(0x77);
  });

  it('mirrors the ROM and registers into page 2 (the DOS kernel polls 0xBFF8)', () => {
    const { mem } = memory(true);
    mem.setPrimarySlots(0b10_11_11_00);          // pages 1 and 2 = slot 3
    expect(mem.readByte(0x8000)).toBe(0x41);
    expect(mem.readByte(0xB000)).toBe(0xFF);
    mem.writeByte(0xBFF8 + 1, 0x5A);             // track register via the mirror
    expect(mem.readByte(0x7FF9)).toBe(0x5A);
    mem.writeByte(0xBFFD, 0x80);
    mem.writeByte(0xBFF8, 0x00);
    expect(mem.readByte(0xBFF8) & 0x04).toBe(0x04);   // TRACK 0 seen through 0xBFF8
  });

  it('takes the card back out of the map', () => {
    const { mem } = memory(true);
    mem.setDiskInterface(null);
    expect(mem.readByte(0x4000)).toBe(0xFF);
  });
});

// ── End to end on a real machine ──────────────────────────────────────────────

/** Machine code: select slot 3 into page 1, motor on, restore, read sector 1 of
 *  track 0 into C000h, then store the final flag byte at F000h and halt. */
const READ_PROGRAM = [
  0xF3,                               // DI
  0x3E, 0xAC, 0xD3, 0xA8,             // LD A,ACh ; OUT (A8h),A
  0x3E, 0x80, 0x32, 0xFD, 0x7F,       // LD A,80h ; LD (7FFDh),A   motor on, drive 0
  0xAF, 0x32, 0xFC, 0x7F,             // XOR A ; LD (7FFCh),A      side 0
  0x32, 0xF8, 0x7F,                   // LD (7FF8h),A              RESTORE
  0x3E, 0x01, 0x32, 0xFA, 0x7F,       // LD A,1 ; LD (7FFAh),A     sector 1
  0x3E, 0x80, 0x32, 0xF8, 0x7F,       // LD A,80h ; LD (7FF8h),A   READ SECTOR
  0x21, 0x00, 0xC0,                   // LD HL,C000h
  0x11, 0x00, 0x02,                   // LD DE,0200h
  0x3A, 0xFF, 0x7F,                   // rd: LD A,(7FFFh)
  0xE6, 0x40,                         //     AND 40h
  0x28, 0xF9,                         //     JR Z,rd
  0x3A, 0xFB, 0x7F,                   //     LD A,(7FFBh)
  0x77, 0x23, 0x1B,                   //     LD (HL),A ; INC HL ; DEC DE
  0x7A, 0xB3,                         //     LD A,D ; OR E
  0x20, 0xEF,                         //     JR NZ,rd
  0x3A, 0xFF, 0x7F,                   // LD A,(7FFFh)
  0x32, 0x00, 0xF0,                   // LD (F000h),A
  0x76,                               // HALT
];

describe('MsxMachine with the disk interface', () => {
  function build(): MsxMachine {
    const m = new MsxMachine('hx-10');
    const bios = new Uint8Array(0x8000).fill(0xFF);
    bios.set(READ_PROGRAM, 0);
    m.loadROM(bios);
    const card = new Uint8Array(0x4000).fill(0xFF);
    card[0] = 0x41; card[1] = 0x42;
    m.loadDiskRom(card);
    m.setFloppyEnabled(true);
    m.loadDisk(patternDisk(), 0);
    m.reset();
    return m;
  }

  it('a Z80 program reads a sector through the memory-mapped registers', () => {
    const m = build();
    try {
      for (let i = 0; i < 20000 && !m.cpu.halted; i++) m.cpu.step();
      expect(m.cpu.halted).toBe(true);
      const ram = m.memory.ramSnapshot();
      const expected = Array.from({ length: 512 }, (_, i) => i & 0xFF);   // logical sector 0
      expect(Array.from(ram.subarray(0xC000, 0xC200))).toEqual(expected);
      const flags = ram[0xF000];
      expect(flags & INTRQ).toBe(INTRQ);
      expect(flags & DRQ).toBe(0);
    } finally { m.destroy(); }
  });

  it('nothing happens without the card: the window reads as an empty slot', () => {
    const m = build();
    try {
      m.setFloppyEnabled(false);
      m.memory.setPrimarySlots(0b10_10_11_00);
      expect(m.memory.readByte(0x4000)).toBe(0xFF);
      expect(m.fdc.getDiskImage(0)).toBeNull();   // disabling ejects
    } finally { m.destroy(); }
  });

  it('is not present until its ROM has been loaded', () => {
    const m = new MsxMachine('hx-10');
    try {
      m.setFloppyEnabled(true);
      expect(m.services.disks.drives).toEqual([]);
      m.loadDiskRom(new Uint8Array(0x4000));
      expect(m.services.disks.drives.map(d => d.id)).toEqual(['a', 'b']);
    } finally { m.destroy(); }
  });

  it('prepare() fits the card from settings and asks for the ROM', () => {
    const m = new MsxMachine('hx-10');
    try {
      const view = { get: <T>(key: string, fallback: T): T =>
        (key === 'msx-floppy' ? true : key === 'write-protect-b' ? true : fallback) as T };
      const reqs = m.prepare(view);
      expect(reqs.map(r => r.source)).toEqual(['msx/msx1_disk-basic.rom']);
      expect(m.floppyEnabled).toBe(true);
      expect(m.fdc.writeProtect).toEqual([false, true, false, false]);
      reqs[0].apply(new Uint8Array(0x4000));
      expect(m.prepare(view)).toEqual([]);   // ROM now present
    } finally { m.destroy(); }
  });

  it('applySettings with the option off removes a fitted card and cold-starts', () => {
    const m = new MsxMachine('hx-10');
    try {
      m.loadDiskRom(new Uint8Array(0x4000));
      m.setFloppyEnabled(true);
      m.loadDisk(patternDisk(), 0);
      m.memory.setPrimarySlots(0b10_10_11_00);
      expect(m.memory.readByte(0x4000)).toBe(0x00);          // fitted: the (all-zero) card ROM answers
      const off = { get: <T>(_k: string, fallback: T): T => fallback };
      m.applySettings(off);
      expect(m.floppyEnabled).toBe(false);
      expect(m.fdc.getDiskImage(0)).toBeNull();
      expect(m.memory.getPrimarySlot()).toBe(0);             // reset ran
      m.memory.setPrimarySlots(0b10_10_11_00);
      expect(m.memory.readByte(0x4000)).toBe(0xFF);          // slot 3 empty again
    } finally { m.destroy(); }
  });

  it('applySettings leaves a card that the setting still wants', () => {
    const m = new MsxMachine('hx-10');
    try {
      m.loadDiskRom(new Uint8Array(0x4000));
      m.setFloppyEnabled(true);
      m.applySettings({ get: <T>(k: string, fallback: T): T => (k === 'msx-floppy' ? true : fallback) as T });
      expect(m.floppyEnabled).toBe(true);
    } finally { m.destroy(); }
  });

  it('prepare() with the option off requests nothing and shows no drives', () => {
    const m = new MsxMachine('hx-10');
    try {
      const view = { get: <T>(_k: string, fallback: T): T => fallback };
      expect(m.prepare(view)).toEqual([]);
      expect(m.services.disks.drives).toEqual([]);
    } finally { m.destroy(); }
  });
});

describe('disk service', () => {
  function fittedMachine(): MsxMachine {
    const m = new MsxMachine('hx-10');
    m.loadDiskRom(new Uint8Array(0x4000));
    m.setFloppyEnabled(true);
    return m;
  }

  it('inserts, reports and ejects media per drive', () => {
    const m = fittedMachine();
    try {
      const svc = m.services.disks;
      svc.insert('b', blankMsxDisk(0xF9), 'work.dsk');
      const [a, b] = svc.drives;
      expect([a.loaded, b.loaded]).toEqual([false, true]);
      expect(b.mediaName).toBe('work.dsk');
      svc.eject('b');
      expect(svc.drives[1].loaded).toBe(false);
    } finally { m.destroy(); }
  });

  it('saves a regular disk as a headerless .dsk and clears dirty', () => {
    const m = fittedMachine();
    try {
      const svc = m.services.disks;
      svc.insert('a', blankMsxDisk(0xF8), 'game.dsk');
      m.fdc.dirty[0] = true;
      const out = svc.save('a')!;
      expect(out.name).toBe('game.dsk');
      expect(out.data.length).toBe(368640);
      expect(m.fdc.isDirty(0)).toBe(false);
    } finally { m.destroy(); }
  });

  it('saves a disk with an erroring sector as extended DSK so nothing is lost', () => {
    const m = fittedMachine();
    try {
      const svc = m.services.disks;
      const img = blankMsxDisk(0xF8);
      img.tracks[3][0]!.sectors[1].st2 = 0x20;
      svc.insert('a', img, 'prot.dsk');
      const out = svc.save('a')!;
      expect(out.name).toBe('prot.edsk');
      expect(String.fromCharCode(...out.data.subarray(0, 8))).toBe('EXTENDED');
    } finally { m.destroy(); }
  });

  it('applies write protect to the right unit', () => {
    const m = fittedMachine();
    try {
      m.services.disks.setWriteProtect('b', true);
      expect(m.fdc.writeProtect.slice(0, 2)).toEqual([false, true]);
      expect(m.services.disks.drives.map(d => d.writeProtected)).toEqual([false, true]);
    } finally { m.destroy(); }
  });

  it('only accepts disk images while the card is fitted', async () => {
    const m = new MsxMachine('hx-10');
    try {
      expect(m.services.media.accepts().map(t => t.ext)).toEqual(['.rom', '.cas', '.tsx', '.tzx', '.wav', '.msxstate']);
      const refused = await m.services.media.mount(new Uint8Array(368640), 'x.dsk');
      expect(refused.ok).toBe(false);
      m.loadDiskRom(new Uint8Array(0x4000));
      m.setFloppyEnabled(true);
      expect(m.services.media.accepts().map(t => t.ext)).toContain('.dmk');
      const ok = await m.services.media.mount(new Uint8Array(368640), 'x.dsk', 'b');
      expect(ok).toMatchObject({ ok: true, target: 'b' });
      expect(m.fdc.getDiskImage(1)).not.toBeNull();
    } finally { m.destroy(); }
  });

  it('reports a bad image as a mount failure', async () => {
    const m = fittedMachine();
    try {
      const r = await m.services.media.mount(new Uint8Array(1000), 'bad.dsk');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Disk error/);
    } finally { m.destroy(); }
  });
});

// ── Through the real BIOS ─────────────────────────────────────────────────────

const BIOS_PATH = join(import.meta.dirname, '../../mcp/.cache/hx-10_basic-bios1.rom');

describe.skipIf(!existsSync(BIOS_PATH))('BIOS slot scan finds the Disk ROM in slot 3', () => {
  it('runs the ROM header INIT routine at power-on', () => {
    const m = new MsxMachine('hx-10');
    try {
      m.loadROM(new Uint8Array(readFileSync(BIOS_PATH)));
      const card = new Uint8Array(0x4000).fill(0xFF);
      card.set([0x41, 0x42, 0x10, 0x40], 0);                  // "AB", INIT = 4010h
      card.set([                                              // INIT: print "DISK" with CHPUT
        0x21, 0x30, 0x40,                                     // LD HL,4030h
        0x7E, 0xB7, 0xC8,                                     // LD A,(HL) ; OR A ; RET Z
        0xCD, 0xA2, 0x00,                                     // CALL 00A2h
        0x23, 0x18, 0xF7,                                     // INC HL ; JR back
      ], 0x10);
      card.set(Array.from('DISKCARD\0', c => c.charCodeAt(0)), 0x30);
      m.loadDiskRom(card);
      m.setFloppyEnabled(true);
      m.turbo = true;
      m.reset();
      for (let i = 0; i < 300; i++) m.tick();
      expect(m.ocrScreenForMcp()).toContain('DISKCARD');
    } finally { m.destroy(); }
  });

  it('leaves the BASIC prompt untouched when the card is not fitted', () => {
    const m = new MsxMachine('hx-10');
    try {
      m.loadROM(new Uint8Array(readFileSync(BIOS_PATH)));
      m.turbo = true;
      m.reset();
      for (let i = 0; i < 300; i++) m.tick();
      const text = m.ocrScreenForMcp();
      expect(text).toContain('MSX BASIC');
      expect(text).not.toContain('DISKCARD');
    } finally { m.destroy(); }
  });
});
