/**
 * The NTSC 64 (6567R8): 65 cycles a line, 263 lines, a 1.022727 MHz clock.
 * The same KERNAL runs on both; it tells them apart by counting raster lines.
 */

import { describe, it, expect } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import { c64Entry, c64Descriptor } from '@/machines/c64/descriptor.ts';
import { c64Timing } from '@/machines/c64/constants.ts';
import { parseD64 } from '@/media/floppy/c64-disk.ts';
import { d64WithFiles, PRINT_B_PRG } from './d64-helper.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';

const basic = romImage('basic-901226-01.rom');
const kernal = romImage('kernal-901227-03.rom');
const chargen = romImage('chargen-901225-01.rom');
const haveRoms = !!(basic && kernal && chargen);

function boot(ntsc: boolean): C64Machine {
  const rom = new Uint8Array(0x5000);
  rom.set(basic!, 0);
  rom.set(kernal!, 0x2000);
  rom.set(chargen!, 0x4000);
  const m = new C64Machine('c64', null, ntsc);
  m.loadROM(rom);
  m.reset();
  for (let f = 0; f < 150; f++) m.tick();
  return m;
}

describe('C64 NTSC timing', () => {
  it('has the 6567R8\'s line, frame and clock', () => {
    const t = c64Timing(true);
    expect(t).toMatchObject({ clockHz: 1_022_727, cyclesPerLine: 65, linesPerFrame: 263, cyclesPerFrame: 17095 });
    expect(t.clockHz / t.cyclesPerFrame).toBeCloseTo(59.83, 2);
    expect(c64Timing(false)).toMatchObject({ clockHz: 985_248, cyclesPerLine: 63, linesPerFrame: 312 });
  });

  it('is built from the us locale, as the Atari\'s is', () => {
    const ntsc = c64Entry.create('c64', null, 'us') as C64Machine;
    const pal = c64Entry.create('c64', null, 'uk') as C64Machine;
    expect(ntsc.timing.ntsc).toBe(true);
    expect(pal.timing.ntsc).toBe(false);
    expect(ntsc.cpuClockHz).toBe(1_022_727);
    expect(ntsc.tStatesPerFrame).toBe(65 * 263);
    expect(ntsc.frameHeight).toBe(235);
    expect(pal.frameHeight).toBe(272);
    expect(ntsc.descriptor.locale).toBe('us');
    expect(ntsc.descriptor.screen.height).toBe(ntsc.frameHeight);
    expect(c64Descriptor('c64', 'us').screen.borderTop).toBe(51 - 27);
    ntsc.destroy(); pal.destroy();
  });

  it('runs a frame in 263 lines of 65 cycles and wraps the raster counter there', () => {
    const m = new C64Machine('c64', null, true);
    m.reset();
    const lines = new Set<number>();
    const t0 = m.cpu.tStates;
    // Spin in RAM so the machine just runs frames.
    m.memory.ram.set([0x4C, 0x00, 0xC0], 0xC000);
    m.cpu.pc = 0xC000;
    m.tick();
    lines.add(m.vic.raster);
    expect(m.vic.raster).toBe(262);
    expect(m.cpu.tStates - t0).toBeGreaterThanOrEqual(65 * 263 - 3);
    expect(m.cpu.tStates - t0).toBeLessThan(65 * 263 + 8);
    m.destroy();
  });

  it('holds the CPU for 43 cycles on a bad line, as on PAL', () => {
    const m = new C64Machine('c64', null, true);
    m.reset();
    m.vic.regs[0x11] = 0x1B;
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
    expect(longest).toBe(7 + 43);
    m.destroy();
  });

  it('fetches sprite 3 at the start of the next line on both chips', () => {
    // The data fetches of sprites 0-7 begin lineEndCycle and run two cycles
    // each, so sprite 3 lands on the first cycle of the next line.
    for (const ntsc of [false, true]) {
      const t = c64Timing(ntsc);
      expect(t.lineEndCycle + 2 * 3).toBe(t.cyclesPerLine);
    }
  });

  it('refuses a snapshot of the other standard', async () => {
    const pal = new C64Machine('c64', null, false);
    const ntsc = new C64Machine('c64', null, true);
    pal.reset(); ntsc.reset();
    const { StateWriter, StateReader } = await import('@/machines/shared/state-io.ts');
    const w = new StateWriter();
    pal.saveState(w, false);
    const r = new StateReader(w.finish());
    expect(() => ntsc.loadState(r)).toThrow(/PAL snapshot.*choose the PAL/);
    pal.destroy(); ntsc.destroy();
  });
});

describe.skipIf(!haveRoms)('C64 NTSC with the real ROMs', () => {
  it('is recognised by the KERNAL as NTSC, and PAL as PAL', () => {
    const ntsc = boot(true);
    const pal = boot(false);
    expect(ntsc.memory.ram[0x02A6]).toBe(0);      // PALNTSC: 0 = NTSC
    expect(pal.memory.ram[0x02A6]).toBe(1);
    expect(ntsc.ocrScreenForMcp()).toMatch(/READY\./);
    ntsc.destroy(); pal.destroy();
  });

  it('keeps time: the jiffy clock runs at 60 a second of frames', () => {
    const m = boot(true);
    const jiffy = () => (m.memory.ram[0xA0] << 16) | (m.memory.ram[0xA1] << 8) | m.memory.ram[0xA2];
    const before = jiffy();
    for (let f = 0; f < 120; f++) m.tick();
    // 120 frames at 59.83 Hz is just over two seconds: about 120 jiffies.
    expect(jiffy() - before).toBeGreaterThanOrEqual(118);
    expect(jiffy() - before).toBeLessThanOrEqual(122);
    m.destroy();
  });

  it('reads a directory from the 1541 on an NTSC machine too', { timeout: 120_000 }, () => {
    const dos = romImage('dos1541-325302-01-901229-05.rom');
    if (!dos) return;
    const m = boot(true);
    m.installDrive(dos);
    m.drive!.insertDisk(parseD64(d64WithFiles([{ name: 'HELLO', data: PRINT_B_PRG }])), false, 'test.d64');
    m.reset();
    for (let f = 0; f < 150; f++) m.tick();
    typeText(m, 'LOAD"$",8' + String.fromCharCode(10));
    for (let f = 0; f < 3000 && !/LOADING\s+READY\./.test(m.ocrScreenForMcp()); f++) m.tick();
    typeText(m, 'LIST' + String.fromCharCode(10));
    for (let f = 0; f < 300; f++) m.tick();
    expect(m.ocrScreenForMcp()).toMatch(/"HELLO\s*"\s+PRG/);
    m.destroy();
  });
});

function typeText(m: C64Machine, text: string): void {
  for (const ch of text) {
    const ev = ch === String.fromCharCode(10)
      ? { code: 'Enter', key: 'Enter', shift: false, ctrl: false, alt: false }
      : { code: '', key: ch, shift: false, ctrl: false, alt: false };
    m.services.input.keyDown(ev);
    for (let f = 0; f < 3; f++) m.tick();
    m.services.input.keyUp(ev);
    for (let f = 0; f < (ch === String.fromCharCode(10) ? 10 : 2); f++) m.tick();
  }
}
