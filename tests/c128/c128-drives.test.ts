/**
 * Disk drives on the 128's serial bus: CIA 2's bus lines as on the 64, the fast
 * serial direction following the MMU's mode register, and — with the real DOS
 * ROMs under mcp/.cache (dos1541.rom, dos1571.rom, dos1581.rom) and the 128's
 * under mcp/.cache/c128-dev — BASIC 7.0's disk commands against a 1571, a 1581
 * and a 1541, with the fast serial (burst) bus carrying the 1571's and 1581's
 * traffic. Expectations are what BASIC 7.0 and the DOS print.
 */

import { describe, it, expect } from 'vitest';
import { C128Machine } from '@/machines/c128/c128-machine.ts';
import { Drive1581 } from '@/machines/shared/cbm/drive/drive-1581.ts';
import { blankD81Bytes } from '@/media/floppy/c64-d81.ts';
import { d64WithFiles, PRINT_B_PRG } from '../c64/d64-helper.ts';
import { d71WithFiles } from '../c64/d71-helper.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';

// ── The bus, with no firmware ─────────────────────────────────────────────────

const CIA2_PRA = 0xDD00, CIA2_DDRA = 0xDD02;

function bare(): C128Machine {
  const m = new C128Machine(null);
  m.reset();
  m.memory.writeByte(0xFF00, 0x00);              // I/O in view
  return m;
}

describe('C128 serial bus lines on CIA 2', () => {
  it('reads CLK and DATA (bits 6 and 7) high on a bus nobody pulls low', () => {
    const m = bare();
    m.memory.writeByte(CIA2_DDRA, 0x3F);
    m.memory.writeByte(CIA2_PRA, 0x00);
    expect(m.memory.readByte(CIA2_PRA) & 0xC0).toBe(0xC0);
  });

  it('reads CLK and DATA low while the machine pulls them: bits 4 and 5 out, inverted', () => {
    const m = bare();
    m.memory.writeByte(CIA2_DDRA, 0x3F);
    m.memory.writeByte(CIA2_PRA, 0x10);
    expect(m.memory.readByte(CIA2_PRA) & 0xC0).toBe(0x80);
    m.memory.writeByte(CIA2_PRA, 0x20);
    expect(m.memory.readByte(CIA2_PRA) & 0xC0).toBe(0x40);
    m.memory.writeByte(CIA2_PRA, 0x30);
    expect(m.memory.readByte(CIA2_PRA) & 0xC0).toBe(0x00);
  });

  it('keeps the VIC bank on bits 0-1 of the same port', () => {
    const m = bare();
    m.memory.writeByte(CIA2_DDRA, 0x3F);
    m.memory.writeByte(CIA2_PRA, 0x02);          // inverted: bank 1
    expect(m.memory.vicBase).toBe(0x4000);
  });
});

describe('C128 drives', () => {
  it('has a 1571 as its drive, by default', () => {
    const m = new C128Machine(null);
    expect(m.driveModels).toEqual(['1571']);
    m.installDrive(new Uint8Array(0x8000));
    expect(m.drive?.model).toBe('1571');
    expect(m.drives).toHaveLength(1);
  });

  it('takes a 1581 or a 1541 when asked, and up to four drives as devices 8 to 11', () => {
    const m = new C128Machine(null);
    m.fitDrives(['1571', '1581', '1541', '1571']);
    expect(m.drives.map((d) => d.model)).toEqual(['1571', '1581', '1541', '1571']);
    expect(m.drives.map((d) => d.unit)).toEqual([0, 1, 2, 3]);
  });

  it('takes every drive off the bus when the ROM is null', () => {
    const m = new C128Machine(null);
    m.installDrive(new Uint8Array(0x8000));
    m.installDrive(null);
    expect(m.drive).toBeNull();
    expect(m.iec.fitted).toBe(false);
  });

  it('points the fast serial port out or in with the mode register\'s bit 3', () => {
    const m = bare();
    expect(m.iec.fastHostTransmits).toBe(false);
    m.memory.mmu.write(5, 0x08);
    expect(m.iec.fastHostTransmits).toBe(true);
    m.memory.mmu.write(5, 0x00);
    expect(m.iec.fastHostTransmits).toBe(false);
  });

  it('has a 1581 listen for burst bytes until the DOS sets CIA port B bit 5, the direction pin', () => {
    const d = new Drive1581();
    expect(d.fastCia).toBe(d.cia);
    expect(d.fastTransmitting).toBe(false);
    d.cia.write(0x03, 0x20);                     // DDRB: bit 5 an output
    d.cia.write(0x01, 0x20);                     // PRB: bit 5 high
    expect(d.fastTransmitting).toBe(true);
    d.cia.write(0x01, 0x00);
    expect(d.fastTransmitting).toBe(false);
  });

  it('starts the drives over with the machine', () => {
    const m = new C128Machine(null);
    m.installDrive(new Uint8Array(0x8000));
    m.reset();
    for (let f = 0; f < 3; f++) m.tick();
    const t = m.drive!.cycles;
    expect(t, 'the drive ran with the machine').toBeGreaterThan(0);
    m.reset();
    expect(m.drive!.cycles).toBeLessThan(t);
  });
});

// ── With the real ROMs ────────────────────────────────────────────────────────

const REAL = 'c128-dev/';
const basicLo = romImage(REAL + 'basiclo');
const basicHi = romImage(REAL + 'basichi');
const kernal = romImage(REAL + 'kernal');
const chargen = romImage(REAL + 'chargen');
const basic64 = romImage(REAL + 'basic64');
const kernal64 = romImage(REAL + 'kernal64');
const dos1571 = romImage('dos1571.rom');
const dos1581 = romImage('dos1581.rom');
const dos1541 = romImage('dos1541.rom');
const haveBoard = !!(basicLo && basicHi && kernal && chargen);

/** A key name and whether SHIFT is down, for a character. */
function chord(ch: string): { key: string; shift?: boolean } {
  switch (ch) {
    case ' ': return { key: 'space' };
    case '\n': return { key: 'return' };
    case '"': return { key: '2', shift: true };
    case '$': return { key: '4', shift: true };
    case '(': return { key: '8', shift: true };
    case ')': return { key: '9', shift: true };
    default: return { key: ch.toLowerCase() };
  }
}

function type(m: C128Machine, text: string): void {
  for (const ch of text) {
    const { key, shift } = chord(ch);
    if (shift) m.keyboard.setKey('lshift', true);
    m.keyboard.setKey(key, true);
    for (let f = 0; f < 4; f++) m.tick();
    m.keyboard.setKey(key, false);
    if (shift) m.keyboard.setKey('lshift', false);
    for (let f = 0; f < (ch === '\n' ? 9 : 3); f++) m.tick();
  }
}

/** Counts of the bits the machine's CIA 1 shifted out and the clock edges it was sent. */
interface BurstCount { out: number; edges: number }

function spyOnBurst(m: C128Machine): BurstCount {
  const count = { out: 0, edges: 0 };
  const shifted = m.cia1.onShiftOut;
  m.cia1.onShiftOut = (bit, t) => { count.out++; shifted?.(bit, t); };
  const edge = m.cia1.cntEdge.bind(m.cia1);
  m.cia1.cntEdge = (t, level) => { count.edges++; edge(t, level); };
  return count;
}

function boot(dos: Uint8Array, model: '1541' | '1571' | '1581', disk: Uint8Array, name: string): C128Machine {
  const m = new C128Machine(null);
  m.loadRoms(basicLo, basicHi, kernal, chargen, basic64, kernal64);
  m.installDrive(dos, model);
  m.drive!.mountImage(disk, name);
  m.reset();
  for (let f = 0; f < 200; f++) m.tick();
  return m;
}

/** Type a command and give the drive time to answer. */
function run(m: C128Machine, command: string, frames = 500): string {
  type(m, command + '\n');
  for (let f = 0; f < frames; f++) m.tick();
  return m.ocrScreenForMcp();
}

const disk71 = (): Uint8Array => d71WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }, { name: 'WORLD', data: PRINT_B_PRG }]);

describe.skipIf(!haveBoard || !dos1571)('C128 with a 1571 and the Commodore ROMs', { timeout: 60_000 }, () => {
  it('lists the directory over the burst bus: the disk name, its files and the blocks free', () => {
    const m = boot(dos1571!, '1571', disk71(), 'test.d71');
    const burst = spyOnBurst(m);
    const text = run(m, 'DIRECTORY');
    expect(text).toMatch(/0 "DEVDISK\s*" 99 2A/);
    expect(text).toMatch(/1\s+"HELLO"\s+PRG/);
    expect(text).toMatch(/1\s+"WORLD"\s+PRG/);
    expect(text).toContain('1326 BLOCKS FREE.');
    expect(burst.out, 'the machine sent its commands in burst mode').toBeGreaterThan(0);
    expect(burst.edges, 'and the drive sent the directory the same way').toBeGreaterThan(100);
  });

  it('loads a program with DLOAD and runs it', () => {
    const m = boot(dos1571!, '1571', disk71(), 'test.d71');
    let text = run(m, 'DLOAD "HELLO"');
    expect(text).toContain('SEARCHING FOR 0:HELLO');
    expect(text).toContain('LOADING');
    text = run(m, 'LIST', 60);
    expect(text).toContain('10 PRINT"B"');
    text = run(m, 'RUN', 60);
    expect(text.split('\n').filter((l) => l === 'B')).toHaveLength(1);
  });

  it('saves with DSAVE: the new file is in the directory and a block less is free', () => {
    const m = boot(dos1571!, '1571', disk71(), 'test.d71');
    run(m, 'DLOAD "HELLO"');
    run(m, 'DSAVE "NEW"', 600);
    const text = run(m, 'DIRECTORY');
    expect(text).toMatch(/1\s+"NEW"\s+PRG/);
    expect(text).toContain('1325 BLOCKS FREE.');
    const saved = m.drive!.saveImage();
    expect(saved?.ext).toBe('.d71');
  });

  it('copies a file with COPY', () => {
    const m = boot(dos1571!, '1571', disk71(), 'test.d71');
    run(m, 'COPY "HELLO" TO "COPYD"', 800);
    const text = run(m, 'DIRECTORY');
    expect(text).toMatch(/1\s+"COPYD"\s+PRG/);
    expect(text).toContain('1325 BLOCKS FREE.');
  });

  it('formats a disk with HEADER: a fresh directory with 1328 blocks free', { timeout: 120_000 }, () => {
    const m = boot(dos1571!, '1571', disk71(), 'test.d71');
    type(m, 'HEADER "BLANK",I55\n');
    for (let f = 0; f < 30; f++) m.tick();
    type(m, 'Y\n');
    for (let f = 0; f < 3000; f++) m.tick();
    const text = run(m, 'DIRECTORY');
    expect(text).toMatch(/0 "BLANK\s*" 55 2A/);
    expect(text).toContain('1328 BLOCKS FREE.');
    expect(text).not.toContain('HELLO');
  });

  it('drives the bus the slow way in C64 mode: LOAD "$",8 lists the disk', () => {
    const m = new C128Machine(null);
    m.loadRoms(basicLo, basicHi, kernal, chargen, basic64, kernal64);
    m.installDrive(dos1571!, '1571');
    m.drive!.mountImage(disk71(), 'test.d71');
    m.reset();
    m.keyboard.setKey('cbm', true);
    for (let f = 0; f < 6; f++) m.tick();
    m.keyboard.setKey('cbm', false);
    for (let f = 0; f < 200; f++) m.tick();
    expect(m.c64Mode).toBe(true);
    type(m, 'LOAD"$",8\n');
    for (let f = 0; f < 600; f++) m.tick();
    type(m, 'LIST\n');
    for (let f = 0; f < 300; f++) m.tick();
    const text = m.ocrScreenForMcp();
    expect(text).toMatch(/"DEVDISK\s*"\s+99 2A/);
    expect(text).toMatch(/"HELLO"\s+PRG/);
    expect(text).toContain('662 BLOCKS FREE');          // one side, as a 1541: 664 less two files
  });
});

describe.skipIf(!haveBoard || !dos1581)('C128 with a 1581 and the Commodore ROMs', { timeout: 60_000 }, () => {
  it('lists a blank disk and saves to it, with the burst bus carrying the traffic', () => {
    const m = boot(dos1581!, '1581', blankD81Bytes(), 'test.d81');
    const burst = spyOnBurst(m);
    let text = run(m, 'DIRECTORY', 800);
    expect(text).toMatch(/0 "ZX84\s*" 01 3D/);
    expect(text).toContain('3160 BLOCKS FREE.');
    run(m, 'DSAVE "X"', 800);
    text = run(m, 'DIRECTORY', 800);
    expect(text).toMatch(/1\s+"X"\s+PRG/);
    expect(text).toContain('3159 BLOCKS FREE.');
    expect(burst.out).toBeGreaterThan(0);
    expect(burst.edges).toBeGreaterThan(100);
  });
});

describe.skipIf(!haveBoard || !dos1541)('C128 with a 1541 and the Commodore ROMs', { timeout: 60_000 }, () => {
  it('lists and loads over the ordinary serial bus: it has no burst mode', () => {
    const m = boot(dos1541!, '1541', d64WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }]), 'test.d64');
    const burst = spyOnBurst(m);
    let text = run(m, 'DIRECTORY', 800);
    expect(text).toMatch(/0 "DEVDISK\s*" 99 2A/);
    expect(text).toContain('663 BLOCKS FREE.');
    run(m, 'DLOAD "HELLO"', 800);
    text = run(m, 'RUN', 60);
    expect(text.split('\n').filter((l) => l === 'B')).toHaveLength(1);
    expect(burst.edges, 'nothing came back by burst').toBe(0);
  });
});
