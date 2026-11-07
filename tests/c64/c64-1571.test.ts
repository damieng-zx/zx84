/**
 * The Commodore 1571 on the serial bus: the double-sided `.d71` disk, and the
 * drive judged by what a user does with the real DOS ROM: LOAD"$",8, LOAD and
 * RUN from either side, SAVE, N: format. The ROMs come from `mcp/.cache`
 * (skipped when absent).
 */

import { describe, it, expect } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import { Drive1541 } from '@/machines/shared/cbm/drive/drive-1541.ts';
import { Drive1571 } from '@/machines/shared/cbm/drive/drive-1571.ts';
import {
  blankC64Disk, blankC64Disk71, blankD64, blankD71, c64DiskImage, decodeTrackSectors, exportD71, isD71, parseC64Disk,
  parseC64Disk71, parseD71, readC64Disk, serializeC64Disk, writeC64Disk,
} from '@/media/floppy/c64-disk.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { blankD81Bytes } from '@/media/floppy/c64-d81.ts';
import { d64WithFiles, PRINT_B_PRG } from './d64-helper.ts';
import { d71WithFiles } from './d71-helper.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

describe('D71 images', () => {
  it('is two D64s end to end: 1366 sectors, 349,696 bytes', () => {
    expect(blankD71()).toHaveLength(349_696);
    expect(isD71(blankD71())).toBe(true);
    expect(isD71(blankD64())).toBe(false);
    expect(isD71(new Uint8Array(349_696 + 1366))).toBe(true);
  });

  it('lays the second side out as the 35 cylinders again, numbered 36-70', () => {
    const disk = parseD71(blankD71());
    expect(disk.tracks.filter(Boolean)).toHaveLength(35);
    expect(disk.tracks1!.filter(Boolean)).toHaveLength(35);
    // Cylinder 1 on side 1 is track 36, with the same 21 sectors and speed as track 1.
    const t36 = disk.tracks1![0]!;
    expect(t36.zone).toBe(3);
    const sectors = decodeTrackSectors(t36);
    expect(sectors).toHaveLength(21);
    expect(sectors.every(s => s.track === 36 && s.headerOk && s.dataOk)).toBe(true);
    const t70 = decodeTrackSectors(disk.tracks1![34 * 2]!);
    expect(t70).toHaveLength(17);
    expect(t70[0].track).toBe(70);
  });

  it('keeps the sectors where the file has them, and reads them back', () => {
    const raw = d71WithFiles([{ name: 'A', data: PRINT_B_PRG }], 1);
    const disk = parseD71(raw);
    expect(same(exportD71(disk)!, raw)).toBe(true);
    expect(serializeC64Disk(disk).ext).toBe('.d71');
    // The file went on track 36, the first of the second side.
    const first = decodeTrackSectors(disk.tracks1![0]!)[0];
    expect([...first.data!.subarray(2, 12)]).toEqual([...PRINT_B_PRG.subarray(0, 10)]);
  });

  it('is a formatted double-sided disk: the DOS\'s flag, side 1\'s counts, and 53/0 kept out of use', () => {
    const raw = blankD71('MYDISK', 'AB');
    const bam = 357 * 256;
    expect(raw[bam + 3]).toBe(0x80);
    expect(raw[bam + 0xDD]).toBe(21);                 // track 36
    expect(raw[bam + 0xDD + (53 - 36)]).toBe(0);      // track 53: the second BAM's own track
    expect(raw[bam + 0xDD + (70 - 36)]).toBe(17);
    let free = 0;
    for (let t = 1; t <= 35; t++) if (t !== 18) free += raw[bam + 4 * t];
    for (let t = 36; t <= 70; t++) free += raw[bam + 0xDD + (t - 36)];
    expect(free).toBe(1328);                          // 664 a side
  });

  it('carries its error table, and an error byte spoils the sector it names', () => {
    const raw = new Uint8Array(349_696 + 1366);
    raw.set(blankD71());
    raw[349_696 + 683 + 5] = 5;                       // side 1, track 36, sector 5: data checksum
    const disk = parseD71(raw);
    const sectors = decodeTrackSectors(disk.tracks1![0]!);
    expect(sectors.find(s => s.sector === 5)!.dataOk).toBe(false);
    expect(sectors.find(s => s.sector === 4)!.dataOk).toBe(true);
    expect(exportD71(disk)).toBeNull();
  });

  it('is not something a 1541 reads, but a 1571 reads everything the 1541 does', () => {
    expect(() => parseC64Disk(blankD71())).toThrow();
    expect(parseC64Disk71(blankD71()).source).toBe('d71');
    expect(parseC64Disk71(blankD64()).source).toBe('d64');
    expect(parseC64Disk71(blankD64()).tracks1).toBeUndefined();
  });

  it('refuses to be saved once a track is not a standard one', () => {
    const disk = blankC64Disk71();
    disk.tracks1![0] = null;
    expect(() => serializeC64Disk(disk)).toThrow(/cannot be saved as a \.d71/);
  });

  it('is described to the Drives pane as two-sided', () => {
    expect(c64DiskImage(blankC64Disk71())).toMatchObject({ numSides: 2, diskFormat: expect.stringMatching(/^D71 \(70 tracks, 342 KB\)/) });
    expect(c64DiskImage(blankC64Disk()).numSides).toBe(1);
  });

  it('is saved in a snapshot with its second side, and a one-sided disk as it always was', () => {
    const w = new StateWriter();
    writeC64Disk(w, blankC64Disk71());
    const back = readC64Disk(new StateReader(w.finish()));
    expect(back.source).toBe('d71');
    expect(back.tracks1!.filter(Boolean)).toHaveLength(35);
    const one = new StateWriter();
    writeC64Disk(one, blankC64Disk());
    expect(readC64Disk(new StateReader(one.finish())).tracks1).toBeUndefined();
  });
});

describe('fitting a 1571', () => {
  const view = (values: Record<string, unknown>) => ({ get: <T>(key: string, fallback: T): T => (key in values ? values[key] as T : fallback) });

  it('asks for its own 32K ROM, and is a 1541 underneath', () => {
    const m = new C64Machine('c64', null);
    const request = m.prepare(view({ 'drive-models:c64': ['1571'] }));
    expect(request[0]).toMatchObject({ source: 'c64/dos1571-310654-05.rom', failId: 'c64-dos1571' });
    expect(m.drive).toBeInstanceOf(Drive1571);
    expect(m.drive).toBeInstanceOf(Drive1541);
    expect(m.drive!.model).toBe('1571');
    expect(m.descriptor.ui.driveModels?.map(d => d.value)).toEqual(['1541', '1571', '1581']);
    m.destroy();
  });

  it('takes .d71 and the 1541\'s disks, and names the drive that cannot', async () => {
    const m = new C64Machine('c64', null);
    m.installDrive(new Uint8Array(0x8000), '1571');
    expect(m.services.media.accepts().map(a => a.ext)).toContain('.d71');
    expect(await m.services.media.mount(blankD71(), 'two.d71')).toMatchObject({ ok: true, target: 'a' });
    expect(await m.services.media.mount(blankD64(), 'one.d64')).toMatchObject({ ok: true, target: 'a' });
    expect(m.drive!.mediaName).toBe('one.d64');
    const wrong = await m.services.media.mount(blankD81Bytes(), 'x.d81');
    expect(wrong).toMatchObject({ ok: false, needsDriveModel: { index: 0, model: '1581' } });
    expect(wrong.message).toMatch(/Drive 8 is a 1571.*\.d64, \.g64 and \.d71/);
    m.destroy();
  });

  it('is asked for by a .d71 on a 1541, and a .d64 does not move a 1571 off its drive', async () => {
    const m = new C64Machine('c64', null);
    m.installDrive(new Uint8Array(0x4000), '1541');
    const r = await m.services.media.mount(blankD71(), 'game.d71');
    expect(r).toMatchObject({ ok: false, needsDriveModel: { index: 0, model: '1571' } });
    expect(r.message).toMatch(/Drive 8 is a 1541.*1571 in the Drives pane/);
    m.destroy();
    const n = new C64Machine('c64', null);
    n.fitDrives(['1571', '1571', '1541']);
    n.installDriveRom('1571', new Uint8Array(0x8000));
    n.installDriveRom('1541', new Uint8Array(0x4000));
    expect(await n.services.media.mount(blankD64(), 'a.d64')).toMatchObject({ ok: true, target: 'a' });
    expect(await n.services.media.mount(blankD64(), 'b.d64')).toMatchObject({ ok: true, target: 'b' });
    expect(await n.services.media.mount(blankD64(), 'c.d64')).toMatchObject({ ok: true, target: 'c' });
    n.destroy();
  });

  it('runs on a 2 MHz time base: a cycle at 1 MHz takes two ticks, and the disk turns as fast either way', () => {
    const d = new Drive1571();
    d.loadRom(new Uint8Array(0x8000).fill(0xEA));        // NOPs
    d.reset();
    expect(d.clockHz).toBe(2_000_000);
    expect(d.cpuHz).toBe(1_000_000);
    d.runTo(2000);                                         // 1000 NOPs' worth of 1 MHz cycles
    expect(d.cpu.tStates).toBeGreaterThanOrEqual(2000);
    expect(d.cpu.tStates).toBeLessThan(2010);
  });
});

describe('1571 state', () => {
  const nops = (): Uint8Array => new Uint8Array(0x8000).fill(0xEA);
  const poke = (d: Drive1571, addr: number, value: number): void => (d as unknown as { busWrite(a: number, v: number): void }).busWrite(addr, value);

  it('is switched to the second head and to 2 MHz by VIA 1 port A, as the DOS does', () => {
    const d = new Drive1571();
    d.loadRom(nops());
    d.mountImage(d71WithFiles([{ name: 'A', data: PRINT_B_PRG }], 1), 'x.d71');
    expect(d.cpuHz).toBe(1_000_000);
    poke(d, 0x1803, 0x66);                 // PA1, PA2, PA5 and PA6 are outputs
    poke(d, 0x1801, 0x04);                 // side 1
    expect(d.describe()[0]).toMatch(/Clock 1 MHz\s+side 1/);
    poke(d, 0x1801, 0x24);                 // and the fast clock
    expect(d.cpuHz).toBe(2_000_000);
    // The same cylinder carries a different track now: the first of side 0 is track 1, of side 1 track 36.
    const sectors = decodeTrackSectors(d.diskImage() ? (d.diskImage() as unknown as { c64: { tracks1: Parameters<typeof decodeTrackSectors>[0][] } }).c64.tracks1[0] : null!);
    expect(sectors[0].track).toBe(36);
  });

  it('comes back from a snapshot in the same mode, on the same side, with both sides of the disk', () => {
    const a = new C64Machine('c64', null);
    a.installDrive(nops(), '1571');
    a.drive!.mountImage(blankD71('SNAP', '55'), 'snap.d71');
    a.reset();
    poke(a.drive as Drive1571, 0x1803, 0x66);
    poke(a.drive as Drive1571, 0x1801, 0x24);
    const w = new StateWriter();
    a.saveState(w, true);
    const b = new C64Machine('c64', null);
    b.installDrive(nops(), '1571');
    b.reset();
    b.loadState(new StateReader(w.finish()));
    const d = b.drive as Drive1571;
    expect(d.cpuHz).toBe(2_000_000);
    expect(d.mediaName).toBe('snap.d71');
    expect(d.describe()[0]).toMatch(/Clock 2 MHz\s+side 1/);
    expect((d.diskImage() as unknown as { c64: { tracks1: unknown[] } }).c64.tracks1.filter(Boolean)).toHaveLength(35);
    // A 1541's snapshot is refused: the drive is another model.
    const c = new C64Machine('c64', null);
    c.installDrive(new Uint8Array(0x4000), '1541');
    c.reset();
    const w2 = new StateWriter();
    c.saveState(w2, false);
    expect(() => b.loadState(new StateReader(w2.finish()))).toThrow(/1541 drive as device 8: set that drive to a 1541/);
    a.destroy(); b.destroy(); c.destroy();
  });
});

const dos = romImage('dos1571.rom');
const basic = romImage('basic-901226-01.rom');
const kernal = romImage('kernal-901227-03.rom');
const chargen = romImage('chargen-901225-01.rom');
const haveRoms = !!(dos && basic && kernal && chargen);

function boot(disk?: Uint8Array, name = 'test.d71'): C64Machine {
  const rom = new Uint8Array(0x5000);
  rom.set(basic!, 0);
  rom.set(kernal!, 0x2000);
  rom.set(chargen!, 0x4000);
  const m = new C64Machine('c64', null);
  m.loadROM(rom);
  m.installDrive(dos!, '1571');
  if (disk) m.drive!.mountImage(disk, name);
  m.reset();
  for (let f = 0; f < 150; f++) m.tick();
  return m;
}

function typeText(m: C64Machine, text: string): void {
  for (const ch of text) {
    const enter = ch === String.fromCharCode(10);
    const ev = enter
      ? { code: 'Enter', key: 'Enter', shift: false, ctrl: false, alt: false }
      : { code: '', key: ch, shift: false, ctrl: false, alt: false };
    m.services.input.keyDown(ev);
    for (let f = 0; f < 3; f++) m.tick();
    m.services.input.keyUp(ev);
    for (let f = 0; f < (enter ? 10 : 2); f++) m.tick();
  }
}

const NL = String.fromCharCode(10);
const screen = (m: C64Machine): string => m.ocrScreenForMcp();

/** A 1571 is a 1541 to a 64 until it is told: U0>M1 is double-sided, 2 MHz. */
function mode1571(m: C64Machine): void {
  typeText(m, 'OPEN15,8,15,"U0>M1":CLOSE15' + NL);
  for (let f = 0; f < 400; f++) m.tick();
}

function runUntil(m: C64Machine, re: RegExp, max = 6000): void {
  let f = 0;
  while (!re.test(screen(m)) && f++ < max) m.tick();
  expect(screen(m), `after ${f} frames`).toMatch(re);
}

describe.skipIf(!haveRoms)('C64 with a 1571 and the Commodore ROMs', () => {
  it('starts: the DOS announces itself on the error channel', { timeout: 120_000 }, () => {
    const m = boot(blankD71());
    typeText(m, '10 OPEN15,8,15:INPUT#15,A,B$:PRINT A;B$:CLOSE15' + NL);
    typeText(m, 'RUN' + NL);
    runUntil(m, /73\s*CBM DOS V3\.\d 1571/);
    m.destroy();
  });

  it('is a 1541 to a 64 until told otherwise: one side, 664 blocks free; U0>M1 makes it a 1571', { timeout: 120_000 }, () => {
    const m = boot(d71WithFiles([{ name: 'FLIP', data: PRINT_B_PRG }], 1));
    typeText(m, 'LOAD"$",8' + NL);
    runUntil(m, /LOADING\s+READY\./);
    typeText(m, 'LIST' + NL);
    for (let f = 0; f < 300; f++) m.tick();
    expect(screen(m)).toMatch(/664 BLOCKS FREE/);
    expect((m.drive as Drive1571).cpuHz).toBe(1_000_000);
    typeText(m, 'OPEN15,8,15,"U0>M1":CLOSE15' + NL);
    for (let f = 0; f < 400; f++) m.tick();
    expect((m.drive as Drive1571).cpuHz).toBe(2_000_000);
    m.destroy();
  });

  it('reads the directory of a double-sided disk: 1328 blocks free on a blank one', { timeout: 120_000 }, () => {
    const m = boot(d71WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }]));
    mode1571(m);
    typeText(m, 'LOAD"$",8' + NL);
    runUntil(m, /LOADING\s+READY\./);
    typeText(m, 'LIST' + NL);
    for (let f = 0; f < 300; f++) m.tick();
    const text = screen(m);
    expect(text).toMatch(/"DEVDISK\s*"\s+99\s+2A/);
    expect(text).toMatch(/"HELLO\s*"\s+PRG/);
    expect(text).toMatch(/1327 BLOCKS FREE/);
    m.destroy();
  });

  it('loads and runs a program from the first side', { timeout: 120_000 }, () => {
    const m = boot(d71WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }]));
    typeText(m, 'LOAD"HELLO",8' + NL);
    runUntil(m, /LOADING\s+READY\./);
    typeText(m, 'RUN' + NL);
    runUntil(m, /RUN\s+B\s+READY\./);
    m.destroy();
  });

  it('loads and runs a program from the second side: the head select works', { timeout: 120_000 }, () => {
    const m = boot(d71WithFiles([{ name: 'FLIP', data: PRINT_B_PRG }], 1));
    mode1571(m);
    typeText(m, 'LOAD"FLIP",8' + NL);
    runUntil(m, /LOADING\s+READY\./);
    typeText(m, 'RUN' + NL);
    runUntil(m, /RUN\s+B\s+READY\./);
    m.destroy();
  });

  it('reads a .d64 as a 1541 would', { timeout: 120_000 }, () => {
    const m = boot(d64WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }]), 'old.d64');
    typeText(m, 'LOAD"HELLO",8' + NL);
    runUntil(m, /LOADING\s+READY\./);
    typeText(m, 'RUN' + NL);
    runUntil(m, /RUN\s+B\s+READY\./);
    m.destroy();
  });

  it('saves to the disk, and what it wrote is a .d71 again', { timeout: 120_000 }, () => {
    const m = boot(blankD71('SAVED', '77'));
    mode1571(m);
    typeText(m, '10 PRINT "SAVED OK"' + NL);
    typeText(m, 'SAVE"TEST",8' + NL);
    runUntil(m, /SAVING TEST\s+READY\./);
    for (let f = 0; f < 100; f++) m.tick();
    typeText(m, 'NEW' + NL);
    typeText(m, 'LOAD"TEST",8' + NL);
    runUntil(m, /LOADING\s+READY\./);
    typeText(m, 'RUN' + NL);
    runUntil(m, /SAVED OK/);
    const out = m.drive!.saveImage()!;
    expect(out.ext).toBe('.d71');
    expect(out.data).toHaveLength(349_696);
    expect(isD71(out.data)).toBe(true);
    m.destroy();
  });

  it('formats a disk on both sides', { timeout: 240_000 }, () => {
    const m = boot(blankD71('OLD', '11'));
    mode1571(m);
    typeText(m, 'OPEN15,8,15,"N:FRESH,42":CLOSE15' + NL);
    // Formatting takes the drive a minute or so; its LED is on until it is done.
    for (let f = 0; f < 200; f++) m.tick();
    let waited = 0;
    while (m.drive!.ledOn && waited++ < 20000) m.tick();
    for (let f = 0; f < 200; f++) m.tick();
    typeText(m, 'LOAD"$",8' + NL);
    runUntil(m, /LOADING\s+READY\./);
    typeText(m, 'LIST' + NL);
    for (let f = 0; f < 300; f++) m.tick();
    const text = screen(m);
    expect(text).toMatch(/"FRESH\s*"\s+42\s+2A/);
    expect(text).toMatch(/1328 BLOCKS FREE/);
    m.destroy();
  });

  it('can be told apart from a 1541 by the fast clock bit', { timeout: 60_000 }, () => {
    const m = boot(blankD71());
    const d = m.drive as Drive1571;
    expect(d.model).toBe('1571');
    expect(d.hasRom).toBe(true);
    expect(d.describe().join('\n')).toMatch(/Clock [12] MHz/);
    m.destroy();
  });
});
