/**
 * The Commodore 1581 on the serial bus: its disk format, and the drive itself
 * judged by what a user does with the real DOS ROM: LOAD"$",8, LOAD and RUN,
 * SAVE, N: format. The ROMs come from `mcp/.cache` (skipped when absent).
 */

import { describe, it, expect } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import { Drive1541 } from '@/machines/shared/cbm/drive/drive-1541.ts';
import { Drive1581 } from '@/machines/shared/cbm/drive/drive-1581.ts';
import { blankD64, parseD64, serializeG64 } from '@/media/floppy/c64-disk.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { blankD81, blankD81Bytes, D81_SIZE, isD81, parseD81, serializeD81 } from '@/media/floppy/c64-d81.ts';
import { d81WithFiles } from './d81-helper.ts';
import { d64WithFiles, PRINT_B_PRG } from './d64-helper.ts';
import { expectExactFromFile, romImage } from '../snapshot/native-state-helpers.ts';

/** Big images compared byte for byte, without the diff machinery of toEqual. */
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

describe('D81 images', () => {
  it('has the 1581\'s geometry: 80 cylinders, two sides, ten 512-byte sectors', () => {
    const image = parseD81(blankD81Bytes())!;
    expect(image.numTracks).toBe(80);
    expect(image.numSides).toBe(2);
    const track = image.tracks[39][1]!;
    expect(track.sectors).toHaveLength(10);
    expect(track.sectors.map(s => s.r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(track.sectors[0].data).toHaveLength(512);
  });

  it('puts the 256-byte sectors where the DOS counts them: 20 to a side, two to a sector', () => {
    const raw = blankD81Bytes();
    raw[(10 * 40 + 0) * 256] = 0x11;            // logical track 11, sector 0
    raw[(10 * 40 + 1) * 256] = 0x22;            // sector 1 is the second half of the same 512
    raw[(10 * 40 + 20) * 256] = 0x33;           // sector 20 begins the other side
    const image = parseD81(raw)!;
    const side0 = image.tracks[10][0]!.sectors[0].data;
    expect(side0[0]).toBe(0x11);
    expect(side0[256]).toBe(0x22);
    expect(image.tracks[10][1]!.sectors[0].data[0]).toBe(0x33);
  });

  it('round-trips, and drops an error table', () => {
    const raw = d81WithFiles([{ name: 'A', data: PRINT_B_PRG }]);
    expect(same(serializeD81(parseD81(raw)!)!, raw)).toBe(true);
    const withErrors = new Uint8Array(D81_SIZE + 3200);
    withErrors.set(raw);
    expect(isD81(withErrors)).toBe(true);
    expect(same(serializeD81(parseD81(withErrors)!)!, raw)).toBe(true);
  });

  it('refuses what is not one', () => {
    expect(parseD81(new Uint8Array(1000))).toBeNull();
    expect(isD81(new Uint8Array(174848))).toBe(false);
  });

  it('is formatted blank: a header, two BAM sectors and an empty directory', () => {
    const raw = blankD81Bytes('MYDISK', 'AB');
    const header = (39 * 40) * 256;
    expect([...raw.subarray(header + 4, header + 10)]).toEqual([...'MYDISK'].map(c => c.charCodeAt(0)));
    expect(raw[header + 0x19]).toBe(0x33);       // DOS version "3D"
    expect(raw[header + 0x1A]).toBe(0x44);
    const bam1 = header + 256;
    expect(raw[bam1 + 0x10]).toBe(40);           // track 1: all free
    expect(raw[bam1 + 0x10 + 39 * 6]).toBe(36);  // track 40: header, BAM x2 and directory are taken
    expect(blankD81().diskFormat).toMatch(/1581/);
  });

  it('cannot be saved once the layout has changed', () => {
    const image = blankD81();
    image.tracks[5][0]!.sectors.pop();
    expect(serializeD81(image)).toBeNull();
  });
});

const blankC64Bytes = (): Uint8Array => blankD64();

describe('choosing the drive', () => {
  const view = (values: Record<string, unknown>) => ({ get: <T>(key: string, fallback: T): T => (key in values ? values[key] as T : fallback) });

  it('fits the 1541 unless the Drives pane set up a 1581, and asks for the ROM of the drive it fitted', () => {
    const a = new C64Machine('c64', null);
    expect(a.prepare(view({}))[0]).toMatchObject({ source: 'c64/dos1541-325302-01-901229-05.rom' });
    expect(a.drive?.model).toBe('1541');
    const b = new C64Machine('c64', null);
    const request = b.prepare(view({ 'drive-models:c64': ['1581'] }));
    expect(request[0]).toMatchObject({ source: 'c64/dos1581-318045-02.rom', failId: 'c64-dos1581' });
    expect(b.drive?.model).toBe('1581');
    expect(b.driveModel).toBe('1581');
    const none = new C64Machine('c64', null);
    expect(none.prepare(view({ 'c64-drive': false, 'drive-models:c64': ['1581'] }))).toEqual([]);
    expect(none.drive).toBeNull();
    a.destroy(); b.destroy(); none.destroy();
  });

  it('replaces the drive when the other DOS ROM goes in, keeping the bus lines', () => {
    const m = new C64Machine('c64', null);
    m.installDrive(new Uint8Array(0x4000), '1541');
    expect(m.drive).toBeInstanceOf(Drive1541);
    m.installDrive(new Uint8Array(0x8000), '1581');
    expect(m.drive).toBeInstanceOf(Drive1581);
    expect(m.drive!.clockHz).toBe(2_000_000);
    m.destroy();
  });

  it('lets the Drives pane switch a drive to a model it has no ROM for: the disk comes out, the choice is reported', () => {
    const m = new C64Machine('c64', null);
    m.installDrive(new Uint8Array(0x4000), '1541');
    m.drive!.mountImage(blankC64Bytes(), 'old.d64');
    expect(m.services.disks.driveModels).toEqual(['1541']);
    m.services.disks.setDriveModel!(0, '1581');
    expect(m.services.disks.driveModels).toEqual(['1581']);
    expect(m.drive!.loaded).toBe(false);
    m.services.disks.setDriveModel!(0, 'nonsense');
    expect(m.services.disks.driveModels).toEqual(['1581']);
    expect(m.descriptor.ui.driveModels?.map(d => d.value)).toEqual(['1541', '1571', '1581']);
    expect(m.descriptor.ui.builtinDrives).toBe(4);
    m.destroy();
  });

  it('offers each drive its own disk formats, and says what to do about the wrong one', async () => {
    const m = new C64Machine('c64', null);
    m.installDrive(new Uint8Array(0x4000), '1541');
    expect(m.services.media.accepts().map(a => a.ext)).toEqual(expect.arrayContaining(['.d64', '.g64', '.g41']));
    // Every format is accepted whichever drives are set up, so a ZIP of a .d81 is unpacked and
    // the wrong-drive message gets to say what to do.
    expect(m.services.media.accepts().map(a => a.ext)).toContain('.d81');
    const wrong = await m.services.media.mount(blankD81Bytes(), 'new.d81');
    expect(wrong.ok).toBe(false);
    expect(wrong.message).toMatch(/Drive 8 is a 1541.*\.d64 and \.g64.*1581 in the Drives pane.*Model/);
    // The shell acts on this: the drive is set to the model that reads it, and the file mounted again.
    expect(wrong.needsDriveModel).toEqual({ index: 0, model: '1581' });
    // .g41 is a G64 by another name.
    const g64 = serializeG64(parseD64(blankD64()));
    expect(await m.services.media.mount(g64, 'copy.g41')).toMatchObject({ ok: true, target: 'a' });
    m.destroy();
  });

  it('asks for the first empty drive to become a 1581 when a .d81 comes and none reads it', async () => {
    const m = new C64Machine('c64', null);
    m.installDrive(new Uint8Array(0x4000), '1541');
    m.services.disks.addDrive!(0);
    m.drives[0].mountImage(blankC64Bytes(), 'full.d64');
    const r = await m.services.media.mount(blankD81Bytes(), 'game.d81');
    expect(r).toMatchObject({ ok: false, needsDriveModel: { index: 1, model: '1581' } });
    // Setting it needs the 1581's ROM, so the machine is rebuilt: the promise settles when it has been.
    let rebuilt = false;
    m.attachHost({
      roms: { rebuild: async () => { rebuilt = true; } },
    } as unknown as Parameters<typeof m.attachHost>[0]);
    const done = m.services.disks.setDriveModel!(1, '1581');
    expect(m.driveModels).toEqual(['1541', '1581']);
    await done;
    expect(rebuilt).toBe(true);
    m.destroy();
  });

  it('refuses a snapshot taken with the other drive, and one from before there was a choice', () => {
    const a = new C64Machine('c64', null);
    a.installDrive(new Uint8Array(0x4000), '1541');
    a.reset();
    const w = new StateWriter();
    a.saveState(w, false);
    const bytes = w.finish();
    const b = new C64Machine('c64', null);
    b.installDrive(new Uint8Array(0x8000), '1581');
    b.reset();
    expect(() => b.loadState(new StateReader(bytes))).toThrow(/1541 drive as device 8: set that drive to a 1541/);
    // The 1581's own state comes back into a 1581.
    const w2 = new StateWriter();
    b.saveState(w2, false);
    const c = new C64Machine('c64', null);
    c.installDrive(new Uint8Array(0x8000), '1581');
    c.reset();
    expect(() => c.loadState(new StateReader(w2.finish()))).not.toThrow();
    // And into a 1541: refused.
    expect(() => a.loadState(new StateReader(w2.finish()))).toThrow(/1581 drive as device 8/);
    a.destroy(); b.destroy(); c.destroy();
  });

  it('dumps the 1581 for chip_state: its CPU, its CIA and its WD1770', () => {
    const m = new C64Machine('c64', null);
    m.installDrive(new Uint8Array(0x8000), '1581');
    m.reset();
    const text = m.services.debug.chips!().find(c => c.name === 'drive')!.dump();
    expect(text).toContain('Commodore 1581 as device 8  (2 MHz)');
    expect(text).toContain('CIA bus interface');
    expect(text).toContain('WD1770 floppy controller');
    m.destroy();
  });
});

describe('several drives', () => {
  const view = (values: Record<string, unknown>) => ({ get: <T>(key: string, fallback: T): T => (key in values ? values[key] as T : fallback) });
  const rom = (model: '1541' | '1581'): Uint8Array => new Uint8Array(model === '1581' ? 0x8000 : 0x4000);

  function two1541s(): C64Machine {
    const m = new C64Machine('c64', null);
    m.installDrive(rom('1541'), '1541');
    return m;
  }

  it('fits the drives the Drives pane set up, one ROM request a model, each at its device number', () => {
    const m = new C64Machine('c64', null);
    const requests = m.prepare(view({ 'drive-models:c64': ['1541', '1581', '1541'] }));
    expect(requests.map(r => r.source)).toEqual(['c64/dos1541-325302-01-901229-05.rom', 'c64/dos1581-318045-02.rom']);
    expect(m.drives.map(d => d.model)).toEqual(['1541', '1581', '1541']);
    expect(m.drives.map(d => d.unit)).toEqual([0, 1, 2]);
    requests[0].apply(rom('1541'));
    requests[1].apply(rom('1581'));
    expect(m.drives.every(d => d.hasRom)).toBe(true);
    expect(m.services.disks.drives.map(d => `${d.id}:${d.label}`)).toEqual(['a:Drive 8', 'b:Drive 9', 'c:Drive 10']);
    expect(m.services.disks.driveModels).toEqual(['1541', '1581', '1541']);
    // More than four, or nonsense, is cut to what the bus takes.
    const n = new C64Machine('c64', null);
    n.prepare(view({ 'drive-models:c64': ['1541', '1541', '1541', '1541', '1581', 'x'] }));
    expect(n.drives).toHaveLength(4);
    m.destroy(); n.destroy();
  });

  it('adds a drive below another, of its model, copying its ROM; the ones below move down a device', () => {
    const m = two1541s();
    const disks = m.services.disks;
    m.drive!.mountImage(blankC64Bytes(), 'one.d64');
    expect(disks.addDrive!(0)).toBe(true);
    expect(m.drives.map(d => d.unit)).toEqual([0, 1]);
    expect(m.drives[1].hasRom).toBe(true);
    expect(m.drives[1].loaded).toBe(false);
    expect(m.drives[0].mediaName).toBe('one.d64');
    // A drive inserted in the middle pushes the one below it down, disk and all.
    m.drives[1].mountImage(blankC64Bytes(), 'two.d64');
    expect(disks.addDrive!(0)).toBe(true);
    expect(m.drives.map(d => d.mediaName)).toEqual(['one.d64', '', 'two.d64']);
    expect(m.drives.map(d => d.unit)).toEqual([0, 1, 2]);
    expect(disks.addDrive!(2)).toBe(true);
    expect(disks.addDrive!(3)).toBe(false);          // four is the most the bus takes
    expect(disks.driveModels).toEqual(['1541', '1541', '1541', '1541']);
    m.destroy();
  });

  it('removes a drive with its disk, the ones below moving up, and keeps the last', () => {
    const m = two1541s();
    const disks = m.services.disks;
    disks.addDrive!(0); disks.addDrive!(1);
    m.drives[0].mountImage(blankC64Bytes(), 'a.d64');
    m.drives[1].mountImage(blankC64Bytes(), 'b.d64');
    m.drives[2].mountImage(blankC64Bytes(), 'c.d64');
    expect(disks.removeDrive!(1)).toBe(true);
    expect(m.drives.map(d => d.mediaName)).toEqual(['a.d64', 'c.d64']);
    expect(m.drives.map(d => d.unit)).toEqual([0, 1]);
    expect(disks.removeDrive!(0)).toBe(true);
    expect(disks.removeDrive!(0)).toBe(false);       // the last one stays
    expect(m.drives).toHaveLength(1);
    m.destroy();
  });

  it('keeps write protect with the place, not the drive that moves into it', () => {
    const m = two1541s();
    m.services.disks.addDrive!(0);
    m.services.disks.setWriteProtect('a', true);
    expect(m.drives.map(d => d.writeProtected)).toEqual([true, false]);
    m.services.disks.addDrive!(0);                   // a new drive 9: the switch stays on device 8
    expect(m.drives.map(d => d.writeProtected)).toEqual([true, false, false]);
    m.destroy();
  });

  it('swaps a drive for the other model in place when that model\'s ROM is fitted already', () => {
    const m = new C64Machine('c64', null);
    m.installDrive(rom('1541'), '1541');
    m.installDrive(rom('1581'), '1581');             // replaces: only a 1581 now
    m.services.disks.addDrive!(0);
    expect(m.drives.map(d => d.model)).toEqual(['1581', '1581']);
    m.installDriveRom('1541', rom('1541'));          // none of that model: nothing to load into
    m.drives[0].mountImage(blankD81Bytes(), 'x.d81');
    m.services.disks.setDriveModel!(1, '1581');      // same model: nothing to do
    expect(m.drives.map(d => d.model)).toEqual(['1581', '1581']);
    m.destroy();
  });

  it('routes each disk to a drive that reads it, and names the drive when it cannot', async () => {
    const m = new C64Machine('c64', null);
    m.prepare(view({ 'drive-models:c64': ['1541', '1581'] }))[0].apply(rom('1541'));
    m.installDriveRom('1581', rom('1581'));
    const exts = m.services.media.accepts().map(a => a.ext);
    expect(exts).toEqual(expect.arrayContaining(['.d64', '.g64', '.g41', '.d81']));
    // With no drive named: the first drive that reads it.
    expect(await m.services.media.mount(blankD81Bytes(), 'game.d81')).toMatchObject({ ok: true, target: 'b' });
    expect(await m.services.media.mount(blankD64(), 'game.d64')).toMatchObject({ ok: true, target: 'a' });
    expect(m.drives.map(d => d.mediaName)).toEqual(['game.d64', 'game.d81']);
    // A drive named, by the shell's unit number or its pane id: it must read the format.
    const wrong = await m.services.media.mount(blankD64(), 'other.d64', 'unit:1');
    expect(wrong.ok).toBe(false);
    expect(wrong.message).toMatch(/Drive 9 is a 1581.*\.d81.*1541 in the Drives pane/);
    expect(await m.services.media.mount(blankD81Bytes(), 'next.d81', 'b')).toMatchObject({ ok: true, target: 'b' });
    expect(await m.services.media.mount(blankD64(), 'next.d64', 'a')).toMatchObject({ ok: true, target: 'a' });
    m.destroy();
  });

  it('sockets the DOS ROM once for each model fitted, whichever drives hold it', () => {
    const m = new C64Machine('c64', null);
    m.prepare(view({ 'drive-models:c64': ['1581', '1541', '1581'] }));
    m.installDriveRom('1541', rom('1541'));
    m.installDriveRom('1581', rom('1581'));
    const slots = m.services.roms.sidewaysSlots;
    expect(slots.map(s => `${s.index}:${s.title}`)).toEqual(['0:1541 DOS', '1:1581 DOS']);
    // A ROM dropped on the 1581 socket goes into both 1581s.
    const custom = new Uint8Array(0x8000).fill(0x77);
    m.services.roms.installSidewaysRom!(1, custom);
    expect(m.drives[0].rom[0]).toBe(0x77);
    expect(m.drives[2].rom[0]).toBe(0x77);
    expect(m.drives[1].rom[0]).toBe(0);
    m.destroy();
  });

  it('is saved and restored as a set, and refuses a set of another size', () => {
    const a = two1541s();
    a.services.disks.addDrive!(0);
    a.drives[1].mountImage(blankC64Bytes(), 'second.d64');
    a.reset();
    const w = new StateWriter();
    a.saveState(w, true);
    const bytes = w.finish();
    const b = two1541s();
    b.services.disks.addDrive!(0);
    b.reset();
    b.loadState(new StateReader(bytes));
    expect(b.drives[1].mediaName).toBe('second.d64');
    const one = two1541s();
    one.reset();
    expect(() => one.loadState(new StateReader(bytes))).toThrow(/more drives than are set up/);
    a.destroy(); b.destroy(); one.destroy();
  });

  it('names a chip for each drive', () => {
    const m = two1541s();
    m.services.disks.addDrive!(0);
    m.services.disks.addDrive!(1);
    const names = m.services.debug.chips!().map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(['drive', 'drive9', 'drive10']));
    expect(m.services.debug.chips!().find(c => c.name === 'drive9')!.dump()).toContain('as device 9');
    m.destroy();
  });

  it('feeds the Drives pane an LED for each drive', () => {
    const m = two1541s();
    m.services.disks.addDrive!(0);
    const out = {
      driveLed: new Int8Array(4).fill(-1), driveTrack: new Int16Array(4), driveSector: new Int16Array(4),
      driveDirty: new Uint8Array(4),
    } as unknown as Parameters<typeof m.services.probe.sample>[0];
    m.services.probe.sample(out);
    expect(out.driveLed[0]).toBeGreaterThanOrEqual(0);
    expect(out.driveLed[1]).toBeGreaterThanOrEqual(0);
    expect(out.driveLed[2]).toBe(-1);
    m.destroy();
  });
});

const dos = romImage('dos1581.rom');
const basic = romImage('basic-901226-01.rom');
const kernal = romImage('kernal-901227-03.rom');
const chargen = romImage('chargen-901225-01.rom');
const haveRoms = !!(dos && basic && kernal && chargen);

function boot(disk?: Uint8Array): C64Machine {
  const rom = new Uint8Array(0x5000);
  rom.set(basic!, 0);
  rom.set(kernal!, 0x2000);
  rom.set(chargen!, 0x4000);
  const m = new C64Machine('c64', null);
  m.loadROM(rom);
  m.installDrive(dos!, '1581');
  if (disk) m.drive!.mountImage(disk, 'test.d81');
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

function runUntil(m: C64Machine, re: RegExp, max = 6000): void {
  let f = 0;
  while (!re.test(screen(m)) && f++ < max) m.tick();
  expect(screen(m), `after ${f} frames`).toMatch(re);
}

describe.skipIf(!haveRoms)('C64 with a 1581 and the Commodore ROMs', () => {
  it('is a 1581 at device 8, 2 MHz, with its ROM', () => {
    const m = boot();
    expect(m.drive).toBeInstanceOf(Drive1581);
    expect(m.drive!.clockHz).toBe(2_000_000);
    expect(m.drive!.hasRom).toBe(true);
    m.destroy();
  });

  it('answers the serial bus: LOAD"$",8 reads the directory', { timeout: 120_000 }, () => {
    const m = boot(d81WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }], 'DEVDISK', '99'));
    typeText(m, 'LOAD"$",8' + NL);
    runUntil(m, /LOADING\s+READY\./);
    typeText(m, 'LIST' + NL);
    for (let f = 0; f < 300; f++) m.tick();
    const text = screen(m);
    expect(text).toMatch(/"DEVDISK\s*"\s+99\s+3D/);
    expect(text).toMatch(/"HELLO\s*"\s+PRG/);
    expect(text).toMatch(/\d+ BLOCKS FREE/);
    m.destroy();
  });

  it('loads a program and runs it', { timeout: 120_000 }, () => {
    const m = boot(d81WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }]));
    typeText(m, 'LOAD"HELLO",8' + NL);
    runUntil(m, /LOADING\s+READY\./);
    typeText(m, 'RUN' + NL);
    for (let f = 0; f < 40; f++) m.tick();
    expect(screen(m)).toMatch(/RUN\s+B\s+READY\./);
    m.destroy();
  });

  it('LOADs a program that spans many sectors, across the track and side boundaries', { timeout: 180_000 }, () => {
    // 20 KB of data for $2000 (away from BASIC's own area, which BASIC relinks
    // after a LOAD): the chain runs over several tracks and both sides.
    const size = 20_000;
    const big = new Uint8Array(2 + size);
    big[0] = 0x00; big[1] = 0x20;
    for (let i = 0; i < size; i++) big[2 + i] = (i * 7 + (i >> 8)) & 0xFF;
    const m = boot(d81WithFiles([{ name: 'BIG', data: big }]));
    typeText(m, 'LOAD"BIG",8,1' + NL);
    runUntil(m, /LOADING\s+READY\./, 9000);
    const ram = m.memory.ram;
    for (let i = 0; i < size; i++) if (ram[0x2000 + i] !== big[2 + i]) expect(ram[0x2000 + i], `byte ${i}`).toBe(big[2 + i]);
    m.destroy();
  });

  it('SAVEs to the disk, so that it reads back and exports as a clean .d81', { timeout: 180_000 }, () => {
    const m = boot(d81WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }]));
    typeText(m, '10 PRINT "SAVED OK"' + NL);
    typeText(m, 'SAVE"TEST",8' + NL);
    runUntil(m, /SAVING TEST\s+READY\.\s*$/);
    for (let f = 0; f < 100; f++) m.tick();
    expect(m.drive!.dirty).toBe(true);
    const saved = m.drive!.saveImage()!;
    expect(saved.ext).toBe('.d81');
    expect(saved.data).toHaveLength(D81_SIZE);
    typeText(m, 'NEW' + NL);
    typeText(m, 'LOAD"TEST",8' + NL);
    runUntil(m, /LOADING\s+READY\./);
    typeText(m, 'RUN' + NL);
    for (let f = 0; f < 40; f++) m.tick();
    expect(screen(m)).toContain('SAVED OK');
    m.destroy();
  });

  it('refuses a write when the disk is write protected', { timeout: 180_000 }, () => {
    const raw = d81WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }]);
    const m = boot(raw);
    m.drive!.setWriteProtect(true);
    for (let f = 0; f < 60; f++) m.tick();
    typeText(m, '10 PRINT "NO"' + NL);
    typeText(m, 'SAVE"BLOCKED",8' + NL);
    for (let f = 0; f < 800; f++) m.tick();
    expect(m.drive!.dirty).toBe(false);
    expect(same(m.drive!.saveImage()!.data, raw)).toBe(true);
    m.destroy();
  });

  it('notices a changed disk, and an empty drive', { timeout: 300_000 }, () => {
    const m = boot(d81WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }]));
    typeText(m, 'LOAD"$",8' + NL);
    runUntil(m, /LOADING\s+READY\./);
    m.drive!.mountImage(d81WithFiles([{ name: 'OTHER', data: PRINT_B_PRG }], 'SECOND', '77'), 'second.d81');
    for (let f = 0; f < 120; f++) m.tick();
    typeText(m, 'LOAD"$",8' + NL);
    runUntil(m, /SEARCHING FOR \$\s+LOADING\s+READY\.\s*$/);
    typeText(m, 'LIST' + NL);
    for (let f = 0; f < 120; f++) m.tick();
    expect(screen(m)).toMatch(/"SECOND\s*"\s+77/);
    expect(screen(m)).toContain('"OTHER"');
    expect(screen(m)).not.toContain('"HELLO"');

    m.drive!.ejectDisk();
    for (let f = 0; f < 120; f++) m.tick();
    typeText(m, 'LOAD"$",8' + NL);
    runUntil(m, /\?FILE NOT FOUND\s+ERROR/);
    m.destroy();
  });

  it('formats a disk with N: and leaves a clean directory', { timeout: 400_000 }, () => {
    const m = boot(blankD81Bytes('OLD', '00'));
    typeText(m, 'OPEN15,8,15,"N:FRESH,42":CLOSE15' + NL);
    // Formatting is a WRITE TRACK for each of 160 tracks: wait for the motor to stop and stay stopped.
    let still = 0;
    for (let f = 0; f < 12_000 && still < 200; f++) {
      m.tick();
      still = m.drive!.motorOn || f < 300 ? 0 : still + 1;
    }
    expect(still, 'the format finished').toBeGreaterThanOrEqual(200);
    typeText(m, 'LOAD"$",8' + NL);
    runUntil(m, /LOADING\s+READY\./);
    typeText(m, 'LIST' + NL);
    for (let f = 0; f < 120; f++) m.tick();
    expect(screen(m)).toMatch(/"FRESH\s*"\s+42\s+3D/);
    expect(screen(m)).toMatch(/3160 BLOCKS FREE/);
    expect(m.drive!.saveImage(), 'every track has the 1581 layout again').not.toBeNull();
    m.destroy();
  });

  it('feeds the Drives pane: LED and track while it works, and the disk activity turbo', { timeout: 120_000 }, () => {
    const m = boot(d81WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }]));
    let sawMotor = false;
    let sawTurbo = false;
    const tick = m.tick.bind(m);
    m.tick = (): void => {
      tick();
      if (m.drive!.motorOn) sawMotor = true;
      if (m.tapeTurboActive) sawTurbo = true;
    };
    m.drive!.takeActivity();
    typeText(m, 'LOAD"HELLO",8' + NL);
    runUntil(m, /LOADING\s+READY\./, 3000);
    expect(sawMotor).toBe(true);
    expect(sawTurbo, 'a disk load runs in turbo').toBe(true);
    expect(m.drive!.currentTrack, 'the head went to the file track').toBeGreaterThan(0);
    expect(m.services.disks.drives).toEqual([
      expect.objectContaining({ id: 'a', label: 'Drive 8', loaded: true, mediaName: 'test.d81' }),
    ]);
    m.destroy();
  });

  it('keeps the load in turbo while the file crosses the serial bus, not just while the controller moves bytes', { timeout: 300_000 }, () => {
    // A 1581 reads a sector in a blink and then spends most of a second sending it: with
    // turbo only for the reading, a long load crawled at real time ("stuck on track 28").
    const size = 12_000;
    const big = new Uint8Array(2 + size);
    big[0] = 0x00; big[1] = 0x20;
    for (let i = 0; i < size; i++) big[2 + i] = (i * 5) & 0xFF;
    const m = boot(d81WithFiles([{ name: 'BIG', data: big }]));
    let turbo = 0;
    let motor = 0;
    const tick = m.tick.bind(m);
    m.tick = (): void => {
      tick();
      if (m.drive!.motorOn) { motor++; if (m.tapeTurboActive) turbo++; }
    };
    typeText(m, 'LOAD"BIG",8,1' + NL);
    runUntil(m, /LOADING\s+READY\./, 9000);
    expect(motor).toBeGreaterThan(500);
    expect(turbo / motor, 'turbo frames of the frames the motor ran').toBeGreaterThan(0.9);
    m.destroy();
  });

  it('takes a disk through the media service, and hands it back', async () => {
    const m = boot();
    const raw = d81WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }]);
    const accepted = m.services.media.accepts().map(a => a.ext);
    expect(accepted).toContain('.d81');
    expect(accepted).toContain('.d64');
    const r = await m.services.media.mount(raw, 'game.d81');
    expect(r).toMatchObject({ ok: true, target: 'a' });
    expect(m.services.disks.drives[0]).toMatchObject({ loaded: true, mediaName: 'game.d81' });
    expect(m.services.disks.image('a')?.diskFormat).toMatch(/1581/);
    const saved = m.services.disks.save('a');
    expect(saved?.name).toBe('game.d81');
    expect(same(saved!.data, raw)).toBe(true);
    // A 1541 disk is not for this drive, and the message says what to do.
    const wrong = await m.services.media.mount(new Uint8Array(174_848), 'old.d64');
    expect(wrong.ok).toBe(false);
    expect(wrong.message).toMatch(/Drive 8 is a 1581.*\.d81.*1541 in the Drives pane/);
    m.services.disks.eject('a');
    expect(m.services.disks.drives[0].loaded).toBe(false);
    m.destroy();
  });

  it('restores exactly from a snapshot, drive, head and disk included', { timeout: 120_000 }, async () => {
    const m = boot(d81WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }]));
    typeText(m, 'LOAD"$",8' + NL);
    for (let f = 0; f < 120; f++) m.tick();            // part-way through the load
    const other = boot();
    await expectExactFromFile(m, other, '.c64state', 8);
  });
});

describe.skipIf(!haveRoms || !romImage('dos1541-325302-01-901229-05.rom'))('a 1541 and a 1581 on the bus together', () => {
  it('answers each at its own device number', { timeout: 300_000 }, () => {
    const dos1541 = romImage('dos1541-325302-01-901229-05.rom')!;
    const all = new Uint8Array(0x5000);
    all.set(basic!, 0);
    all.set(kernal!, 0x2000);
    all.set(chargen!, 0x4000);
    const m = new C64Machine('c64', null);
    m.loadROM(all);
    m.fitDrives(['1541', '1581', '1541']);
    m.installDriveRom('1541', dos1541);
    m.installDriveRom('1581', dos!);
    m.drives[0].mountImage(d64WithFiles([{ name: 'ON8', data: PRINT_B_PRG }], 'DISK EIGHT', '08'), 'eight.d64');
    m.drives[1].mountImage(d81WithFiles([{ name: 'ON9', data: PRINT_B_PRG }], 'DISK NINE', '09'), 'nine.d81');
    m.drives[2].mountImage(d64WithFiles([{ name: 'ON10', data: PRINT_B_PRG }], 'DISK TEN', '10'), 'ten.d64');
    m.reset();
    for (let f = 0; f < 200; f++) m.tick();
    for (const [device, name] of [[8, 'DISK EIGHT'], [9, 'DISK NINE'], [10, 'DISK TEN']] as const) {
      typeText(m, `LOAD"$",${device}` + NL);
      runUntil(m, /LOADING\s+READY\.\s*$/);
      typeText(m, 'LIST' + NL);
      for (let f = 0; f < 150; f++) m.tick();
      expect(screen(m), `device ${device}`).toContain(`"${name}`);
      typeText(m, 'NEW' + NL);
    }
    typeText(m, 'LOAD"ON9",9' + NL);
    runUntil(m, /LOADING\s+READY\.\s*$/);
    typeText(m, 'RUN' + NL);
    for (let f = 0; f < 60; f++) m.tick();
    expect(screen(m)).toMatch(/RUN\s+B\s+READY\./);
    // Nothing answers at device 11.
    typeText(m, 'LOAD"$",11' + NL);
    runUntil(m, /DEVICE NOT PRESENT/, 3000);
    m.destroy();
  });
});

describe('1581 ROM size', () => {
  it('is the 32K the DOS lives in', () => {
    expect(new Drive1581().romSize).toBe(0x8000);
  });
});
