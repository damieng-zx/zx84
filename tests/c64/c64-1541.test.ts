/**
 * The Commodore 1541 disk drive on the C64's serial bus.
 *
 * Expectations come from the hardware: the VIC-II holds the CPU for 43 cycles
 * on a bad line; a 1541 turns a track in 200 ms (a byte every 26 cycles on the
 * outer tracks, up to 32 on the inner); the stepper moves a half-track when
 * its phase counts up or down by one; ATN is answered by the drive's own
 * hardware before any firmware runs. With the Commodore DOS ROM the drive is
 * then judged by what a user does: LOAD"$",8, LOAD and RUN, SAVE.
 */

import { describe, it, expect } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import { Drive1541, DRIVE_ROM_SIZE } from '@/machines/shared/cbm/drive/drive-1541.ts';
import {
  blankC64Disk, exportD64, parseD64, parseG64, serializeG64,
} from '@/media/floppy/c64-disk.ts';
import { d64WithFiles, PRINT_B_PRG } from './d64-helper.ts';
import { expectExactFromFile, romImage } from '../snapshot/native-state-helpers.ts';

describe('C64 bad-line stall', () => {
  it('holds the CPU for a bad line once, not twice', () => {
    const m = new C64Machine('c64', null);
    m.reset();
    m.vic.regs[0x11] = 0x1B;                    // display on, 25 rows, YSCROLL 3
    // SEI, then LDA $DD00 / JMP in a 7-cycle loop, timed by its reads.
    m.memory.ram.set([0x78, 0xAD, 0x00, 0xDD, 0x4C, 0x01, 0xC0], 0xC000);
    m.cpu.pc = 0xC000;
    let prev = -1;
    let longest = 0;
    const portAIn = m.cia2.portAIn;
    m.cia2.portAIn = (driven) => {
      const t = m.cpu.tStates;
      if (prev >= 0) longest = Math.max(longest, t - prev);
      prev = t;
      return portAIn(driven);
    };
    for (let f = 0; f < 3; f++) m.tick();
    expect(longest).toBe(7 + 43);               // the loop, plus one hold
  });
});

/** The 1541 on the machine, for the tests that look inside it. */
const d1541 = (m: C64Machine): Drive1541 => m.drive as Drive1541;

/** The drive's internals a hardware test pokes at. */
interface DriveInternals {
  busWrite(addr: number, value: number): void;
  busRead(addr: number): number;
  advanceHead(cycles: number): void;
  clockBit(): void;
  bitPos: number;
  track: { bits: Uint8Array; length: number } | null;
  writeShift: number;
  via2Pins(): number;
  halfTrack: number;
}
const internals = (d: Drive1541): DriveInternals => d as unknown as DriveInternals;

/** A drive that has never run firmware: the mechanics alone. */
function bareDrive(): Drive1541 {
  const d = new Drive1541();
  d.insertDisk(parseD64(d64WithFiles([])), false, 'bare.d64', true);
  return d;
}

describe('1541 mechanics', () => {
  it('steps a half-track each time the stepper phase counts up or down by one', () => {
    const d = bareDrive();
    const i = internals(d);
    i.busWrite(0x1C02, 0x6F);                   // port B directions, as the DOS sets them
    i.busWrite(0x1C00, 0x60);                   // phase 0
    const start = d.currentHalfTrack;
    i.busWrite(0x1C00, 0x61);
    i.busWrite(0x1C00, 0x62);
    expect(d.currentHalfTrack).toBe(start + 2);
    i.busWrite(0x1C00, 0x61);
    expect(d.currentHalfTrack).toBe(start + 1);
    i.busWrite(0x1C00, 0x63);                   // a jump of two is not a step
    expect(d.currentHalfTrack).toBe(start + 1);
    for (let n = 0; n < 200; n++) i.busWrite(0x1C00, 0x60 | ((n + 4) & 3) ^ 0);
    expect(d.currentHalfTrack).toBeGreaterThanOrEqual(0);
    expect(d.currentHalfTrack).toBeLessThan(84);
  });

  it('turns a standard track in 200 ms of cycles when the motor is on', () => {
    const d = bareDrive();
    const i = internals(d);
    i.busWrite(0x1C02, 0x6F);
    i.busWrite(0x1C00, 0x04 | (3 << 5));        // motor on, speed zone 3
    expect(d.motorOn).toBe(true);
    const length = i.track!.length;             // track 18 (zone 2) is where the head starts
    // Zone 3 is 26 cycles a byte; use the track's own zone to find a revolution.
    i.busWrite(0x1C00, 0x04 | (i.track!.length === 7692 * 8 ? 3 : 2) << 5);
    i.bitPos = 0;
    const zone = (i.via2Pins(), 0);
    expect(zone).toBe(0);
    const cyclesPerBit = length === 7692 * 8 ? 3.25 : length === 7142 * 8 ? 3.5 : 3.75;
    i.advanceHead(Math.round(length * cyclesPerBit));
    expect(i.bitPos).toBeLessThan(16);          // back at the start, give or take a byte
  });

  it('stands still with the motor off', () => {
    const d = bareDrive();
    const i = internals(d);
    i.bitPos = 100;
    i.advanceHead(50_000);
    expect(i.bitPos).toBe(100);
  });

  it('reads sync as port B bit 7 low, and holds the byte counter until it ends', () => {
    const d = bareDrive();
    const i = internals(d);
    i.busWrite(0x1C02, 0x6F);
    i.busWrite(0x1C00, 0x04 | (2 << 5));
    i.track!.bits.fill(0, 0, i.track!.bits.length);
    i.track!.bits[0] = 0xFF; i.track!.bits[1] = 0xFF; i.track!.bits[2] = 0x55;
    i.bitPos = 0;
    for (let b = 0; b < 12; b++) i.clockBit();           // twelve ones of sixteen
    expect(i.via2Pins() & 0x80).toBe(0);                 // in sync
    for (let b = 0; b < 5; b++) i.clockBit();            // the last four ones, then the first zero
    expect(i.via2Pins() & 0x80).toBe(0x80);              // sync is over
  });

  it('writes the shift register to the track a bit at a time, unless write protected', () => {
    const d = bareDrive();
    const i = internals(d);
    i.busWrite(0x1C02, 0x6F);
    i.busWrite(0x1C00, 0x04 | (2 << 5));
    d.via2.write(12, 0xC0);                              // CB2 low: write mode
    i.track!.bits.fill(0);
    i.bitPos = 80;
    i.writeShift = 0xA5;
    for (let b = 0; b < 8; b++) i.clockBit();
    expect(i.track!.bits[10]).toBe(0xA5);
    expect(d.dirty).toBe(true);

    d.dirty = false;
    d.setWriteProtect(true);
    i.bitPos = 160;
    i.writeShift = 0xFF;
    for (let b = 0; b < 8; b++) i.clockBit();
    expect(i.track!.bits[20]).toBe(0);
    expect(d.dirty).toBe(false);
  });

  it('reports a writable disk on port B bit 4, and a change when the disk is swapped', () => {
    const d = bareDrive();
    const i = internals(d);
    const writable = (): boolean => (i.via2Pins() & 0x10) !== 0;
    d.cpu.tStates = 1_000_000;
    d.setWriteProtect(false);
    d.cpu.tStates += 100_000;
    expect(writable()).toBe(true);
    d.setWriteProtect(true);
    expect(writable(), 'the sensor flickers on a change').toBe(true);
    d.cpu.tStates += 100_000;
    expect(writable()).toBe(false);
    d.ejectDisk();
    d.cpu.tStates += 100_000;
    expect(writable(), 'no disk, no tab to feel').toBe(false);
  });
});

describe('1541 serial bus', () => {
  it('holds DATA low by itself while ATN is asserted, until the DOS acknowledges', () => {
    const d = bareDrive();
    const i = internals(d);
    expect(d.dataAsserted).toBe(false);
    d.setHostLines(true, false, false);                   // the 64 asserts ATN
    expect(d.dataAsserted, 'hardware acknowledge').toBe(true);
    i.busWrite(0x1802, 0x1A);                            // DATA OUT, CLK OUT and ATNA are outputs
    i.busWrite(0x1800, 0x10);                            // ATNA set: it agrees with ATN
    expect(d.dataAsserted).toBe(false);
    d.setHostLines(false, false, false);                  // ATN released, ATNA still set
    expect(d.dataAsserted, 'the mismatch holds DATA until ATNA is cleared').toBe(true);
    i.busWrite(0x1800, 0x00);
    expect(d.dataAsserted).toBe(false);
  });

  it('pulls CLK and DATA low from the DOS output bits, and reads them inverted', () => {
    const d = bareDrive();
    const i = internals(d);
    i.busWrite(0x1802, 0x1A);
    i.busWrite(0x1800, 0x08);
    expect(d.clkAsserted).toBe(true);
    expect(d.dataAsserted).toBe(false);
    i.busWrite(0x1800, 0x02);
    expect(d.clkAsserted).toBe(false);
    expect(d.dataAsserted).toBe(true);
    // Inputs: a set bit is a line held low. The 64 pulling CLK low shows on bit 2.
    d.setHostLines(false, true, false);
    expect(i.busRead(0x1800) & 0x04).toBe(0x04);
    d.setHostLines(true, false, false);
    expect(i.busRead(0x1800) & 0x80).toBe(0x80);
  });

  it('is device 8', () => {
    const d = bareDrive();
    expect(internals(d).busRead(0x1800) & 0x60).toBe(0);
  });
});

// ── With the Commodore ROMs ────────────────────────────────────────────────

const basic = romImage('basic-901226-01.rom');
const kernal = romImage('kernal-901227-03.rom');
const chargen = romImage('chargen-901225-01.rom');
const dos = romImage('dos1541-325302-01-901229-05.rom');
const haveRoms = !!(basic && kernal && chargen && dos);

function withDrive(disk?: Uint8Array): C64Machine {
  const rom = new Uint8Array(0x5000);
  rom.set(basic!, 0);
  rom.set(kernal!, 0x2000);
  rom.set(chargen!, 0x4000);
  const m = new C64Machine('c64', null);
  m.loadROM(rom);
  m.installDrive(dos!);
  if (disk) d1541(m).insertDisk(parseD64(disk), false, 'test.d64');
  m.reset();
  for (let f = 0; f < 150; f++) m.tick();
  return m;
}

function typeText(m: C64Machine, text: string): void {
  for (const ch of text) {
    const ev = ch === '\n'
      ? { code: 'Enter', key: 'Enter', shift: false, ctrl: false, alt: false }
      : { code: '', key: ch, shift: false, ctrl: false, alt: false };
    m.services.input.keyDown(ev);
    for (let f = 0; f < 3; f++) m.tick();
    m.services.input.keyUp(ev);
    for (let f = 0; f < (ch === '\n' ? 10 : 2); f++) m.tick();
  }
}

/** Run until the screen matches, failing the test after `max` frames. */
function runUntil(m: C64Machine, re: RegExp, max = 6000): void {
  let f = 0;
  while (!re.test(m.ocrScreenForMcp()) && f++ < max) m.tick();
  expect(m.ocrScreenForMcp(), `after ${f} frames`).toMatch(re);
}

const screen = (m: C64Machine): string => m.ocrScreenForMcp();
const loaded = /LOADING\s+READY\.\s*$/;

describe.skipIf(!haveRoms)('C64 with a 1541 and the Commodore ROMs', () => {
  const disk = () => d64WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }]);

  it('answers the serial bus: LOAD"$",8 finds the device and reads the directory', { timeout: 120_000 }, () => {
    const m = withDrive(disk());
    typeText(m, 'LOAD"$",8\n');
    runUntil(m, loaded);
    typeText(m, 'LIST\n');
    for (let f = 0; f < 60; f++) m.tick();
    const s = screen(m);
    expect(s).toContain('0 "DEVDISK         " 99 2A');
    expect(s).toContain('1    "HELLO"            PRG');
    expect(s).toContain('663 BLOCKS FREE.');
    expect(m.drive!.currentTrack, 'the head went to the directory track').toBe(18);
  });

  it('loads a program and runs it', { timeout: 120_000 }, () => {
    const m = withDrive(disk());
    typeText(m, 'LOAD"HELLO",8\n');
    runUntil(m, loaded);
    typeText(m, 'RUN\n');
    for (let f = 0; f < 40; f++) m.tick();
    expect(screen(m)).toMatch(/RUN\nB\n\nREADY\.$/);
  });

  it('reports an empty bus as no device, with no drive fitted', { timeout: 60_000 }, () => {
    const m = withDrive(disk());
    m.installDrive(null);
    typeText(m, 'LOAD"$",8\n');
    runUntil(m, /DEVICE NOT PRESENT/, 3000);
  });

  it('SAVEs to the disk, so that it reads back and exports as a clean .d64', { timeout: 180_000 }, () => {
    const m = withDrive(disk());
    typeText(m, '10 PRINT "SAVED OK"\n');
    typeText(m, 'SAVE"TEST",8\n');
    runUntil(m, /SAVING TEST\s+READY\.\s*$/);
    for (let f = 0; f < 100; f++) m.tick();
    expect(m.drive!.dirty).toBe(true);
    const d64 = exportD64(d1541(m).disk!);
    expect(d64, 'every sector still decodes').not.toBeNull();
    typeText(m, 'NEW\n');
    typeText(m, 'LOAD"TEST",8\n');
    runUntil(m, loaded);
    typeText(m, 'RUN\n');
    for (let f = 0; f < 40; f++) m.tick();
    expect(screen(m)).toContain('SAVED OK');
  });

  it('refuses a write when the disk is write protected', { timeout: 180_000 }, () => {
    const m = withDrive(disk());
    m.drive!.setWriteProtect(true);
    for (let f = 0; f < 60; f++) m.tick();
    typeText(m, '10 PRINT "NO"\n');
    typeText(m, 'SAVE"BLOCKED",8\n');
    for (let f = 0; f < 800; f++) m.tick();
    expect(m.drive!.dirty).toBe(false);
    // Nothing was written: the disk is as it was, with no such file in its directory.
    const d64 = exportD64(d1541(m).disk!)!;
    expect(d64).toEqual(disk());
    expect(Buffer.from(d64).includes('BLOCKED')).toBe(false);
  });

  it('notices a changed disk, including a .g64, and an empty drive', { timeout: 300_000 }, () => {
    const m = withDrive(disk());
    typeText(m, 'LOAD"$",8\n');
    runUntil(m, loaded);
    const other = d64WithFiles([{ name: 'OTHER', data: PRINT_B_PRG }], 'SECOND', '77');
    d1541(m).insertDisk(parseG64(serializeG64(parseD64(other))), false, 'second.g64');
    for (let f = 0; f < 120; f++) m.tick();
    typeText(m, 'LOAD"$",8\n');
    runUntil(m, /SEARCHING FOR \$\s+LOADING\s+READY\.\s*$/);
    typeText(m, 'LIST\n');
    for (let f = 0; f < 60; f++) m.tick();
    expect(screen(m)).toContain('0 "SECOND          " 77 2A');
    expect(screen(m)).toContain('"OTHER"');
    expect(screen(m)).not.toContain('"HELLO"');

    m.drive!.ejectDisk();
    for (let f = 0; f < 120; f++) m.tick();
    typeText(m, 'LOAD"$",8\n');
    runUntil(m, /\?FILE NOT FOUND\s+ERROR/);
  });

  it('formats a disk with N: and leaves a clean directory', { timeout: 400_000 }, () => {
    const m = withDrive();
    d1541(m).insertDisk(blankC64Disk('OLD', '00'), false, 'blank.d64');
    for (let f = 0; f < 150; f++) m.tick();
    typeText(m, 'OPEN15,8,15,"N:FRESH,42":CLOSE15\n');
    // A real format takes the best part of a minute: wait for the motor to
    // stop and stay stopped.
    let still = 0;
    for (let f = 0; f < 8000 && still < 100; f++) {
      m.tick();
      still = m.drive!.motorOn || f < 300 ? 0 : still + 1;
    }
    expect(still, 'the format finished').toBeGreaterThanOrEqual(100);
    typeText(m, 'LOAD"$",8\n');
    runUntil(m, loaded);
    typeText(m, 'LIST\n');
    for (let f = 0; f < 60; f++) m.tick();
    expect(screen(m)).toContain('0 "FRESH           " 42 2A');
    expect(screen(m)).toContain('664 BLOCKS FREE.');
    expect(exportD64(d1541(m).disk!), 'every track was rewritten readably').not.toBeNull();
  });

  it('feeds the Drives pane: LED and track while it works, and the disk activity turbo', { timeout: 120_000 }, () => {
    const m = withDrive(disk());
    typeText(m, 'LOAD"$",8\n');
    let sawMotor = false;
    let sawTurbo = false;
    for (let f = 0; f < 3000 && !loaded.test(screen(m)); f++) {
      m.tick();
      if (m.drive!.motorOn) sawMotor = true;
      if (m.tapeTurboActive) sawTurbo = true;
    }
    expect(sawMotor).toBe(true);
    expect(sawTurbo, 'a disk load runs in turbo').toBe(true);
    const out = {
      driveLed: new Int8Array(4), driveTrack: new Int16Array(4), driveSector: new Int16Array(4),
      driveDirty: new Uint8Array(4),
    };
    expect(out.driveLed.length).toBe(4);
    expect(m.services.disks.drives).toEqual([
      expect.objectContaining({ id: 'a', label: 'Drive 8', loaded: true, mediaName: 'test.d64' }),
    ]);
  });

  it('puts a disk in through the media service and takes it out again', async () => {
    const m = withDrive();
    const r = await m.services.media.mount(disk(), 'game.d64');
    expect(r).toMatchObject({ ok: true, target: 'a' });
    expect(m.services.disks.drives[0]).toMatchObject({ loaded: true, mediaName: 'game.d64' });
    expect(m.services.disks.image('a')?.diskFormat).toBe('D64 (35 tracks, 171 KB)');
    const saved = m.services.disks.save('a');
    expect(saved?.name).toBe('game.d64');
    expect(saved?.data).toEqual(disk());
    m.services.disks.eject('a');
    expect(m.services.disks.drives[0].loaded).toBe(false);
    const bad = await m.services.media.mount(new Uint8Array(100), 'junk.d64');
    expect(bad.ok).toBe(false);
  });

  it('restores exactly from a snapshot, drive, head and disk included', { timeout: 120_000 }, async () => {
    const m = withDrive(disk());
    typeText(m, 'LOAD"$",8\n');
    for (let f = 0; f < 200; f++) m.tick();            // part-way through the load
    await expectExactFromFile(m, withDrive(), '.c64state', 8);
  });
});

describe('1541 ROM size', () => {
  it('is the 16K the DOS lives in', () => {
    expect(DRIVE_ROM_SIZE).toBe(0x4000);
  });
});
