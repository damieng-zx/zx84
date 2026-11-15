/**
 * The 128's 2 MHz mode: $D030 bit 0 in C128 mode doubles the 8502's speed
 * against the 1 MHz clock the other chips keep, except that every access to
 * the I/O page runs at 1 MHz, and shuts the VIC-IIe off (the border colour
 * everywhere, no bad lines, no sprite DMA). The 64's map has no such
 * register. Programs are assembled by hand into a ROM-less machine whose Z80
 * BIOS copies them to $1100 and starts the 8502 there (`hand-bios.ts`); with the real ROMs,
 * BASIC's FAST and SLOW commands turn it on and off.
 */

import { describe, it, expect } from 'vitest';
import { C128Machine } from '@/machines/c128/c128-machine.ts';
import { VIC_PALETTE } from '@/machines/shared/cbm/vic-ii-board.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';
import { counter, machineRunning } from './hand-bios.ts';

const count = (m: C128Machine): number => m.memory.ram[0xFC] * 256 + m.memory.ram[0xFB];
const run = (m: C128Machine, frames: number): void => { for (let f = 0; f < frames; f++) m.tick(); };

/** How many times the loop ran in `frames` frames, after a few for the start-up. */
function rate(program: number[], frames = 10): number {
  const m = machineRunning(program);
  run(m, 3);
  const before = count(m);
  run(m, frames);
  const n = (count(m) - before) & 0xFFFF;
  m.destroy();
  return n;
}

describe('2 MHz mode', () => {
  it('runs the 8502 twice as fast when $D030 bit 0 is set', () => {
    const slow = rate(counter(0));
    const fast = rate(counter(1));
    expect(slow).toBeGreaterThan(1000);
    expect(fast / slow).toBeGreaterThan(1.95);
    expect(fast / slow).toBeLessThan(2.05);
  });

  it('keeps an access to the I/O page at 1 MHz', () => {
    const readIo = [0xAD, 0x20, 0xD0];                    // LDA $D020
    const pure = rate(counter(1)) / rate(counter(0));
    const io = rate(counter(1, readIo)) / rate(counter(0, readIo));
    expect(io).toBeLessThan(pure);
    expect(io).toBeGreaterThan(1.6);
  });

  it('has no effect in C64 mode, which has no $D030', () => {
    const fastMachine = machineRunning(counter(1));
    const slowMachine = machineRunning(counter(0));
    for (const m of [fastMachine, slowMachine]) {
      run(m, 3);
      m.memory.mmu.mcr |= 0x40;
      m.memory.pinsChanged();
    }
    expect(fastMachine.fast2MHz).toBe(false);
    const f0 = count(fastMachine), s0 = count(slowMachine);
    run(fastMachine, 20); run(slowMachine, 20);
    const f = (count(fastMachine) - f0) & 0xFFFF, s = (count(slowMachine) - s0) & 0xFFFF;
    expect(f / s).toBeGreaterThan(0.98);
    expect(f / s).toBeLessThan(1.02);
    fastMachine.destroy(); slowMachine.destroy();
  });

  it('blanks the VIC-IIe: the border colour everywhere', () => {
    const setup = (d030: number): number[] => [
      0xA9, 0x1B, 0x8D, 0x11, 0xD0,                       // LDA #$1B : STA $D011   display on
      0xA9, 0x02, 0x8D, 0x20, 0xD0,                       // LDA #2   : STA $D020   border red
      0xA9, 0x05, 0x8D, 0x21, 0xD0,                       // LDA #5   : STA $D021   background green
      0xA9, d030, 0x8D, 0x30, 0xD0,                       // LDA #n   : STA $D030
      0x4C, 0x14, 0x11,                                   // JMP *
    ];
    const colours = (m: C128Machine): Set<number> => {
      run(m, 6);
      return new Set(m.vic.pixels);
    };
    const normal = machineRunning(setup(0));
    expect(colours(normal).size, 'border and picture').toBeGreaterThan(1);
    const fast = machineRunning(setup(1));
    expect([...colours(fast)]).toEqual([VIC_PALETTE[2]]);
    expect(fast.vic.blank).toBe(true);
    // Back to normal when the bit is cleared.
    fast.memory.ioWrite(0xD030, 0);
    run(fast, 2);
    expect(fast.fast2MHz).toBe(false);
    expect(colours(fast).size).toBeGreaterThan(1);
    normal.destroy(); fast.destroy();
  });

  it('is off after a reset, and kept in a snapshot', () => {
    const a = machineRunning(counter(1));
    run(a, 4);
    expect(a.fast2MHz).toBe(true);
    const w = new StateWriter();
    a.saveState(w, false);
    const b = new C128Machine(null);
    b.loadState(new StateReader(w.finish()));
    expect(b.fast2MHz).toBe(true);
    run(b, 2);
    expect(b.vic.blank).toBe(true);
    b.reset();
    expect(b.fast2MHz).toBe(false);
    run(b, 1);
    expect(b.vic.blank).toBe(false);
    a.destroy(); b.destroy();
  });

  it('is shown in the memory map pane and the VIC chip dump', () => {
    const m = machineRunning(counter(1));
    run(m, 4);
    const clock = m.services.probe.panes!.memoryMap!()!.registers.find(r => r.name === 'Clock');
    expect(clock?.value).toContain('2 MHz');
    expect(m.chips().find(c => c.name === 'vic')!.dump()).toContain('2 MHz: the 8502 runs at twice');
    m.destroy();
  });
});

const REAL = 'c128-dev/';
const basicLo = romImage(REAL + 'basiclo');
const basicHi = romImage(REAL + 'basichi');
const kernal = romImage(REAL + 'kernal');
const chargen = romImage(REAL + 'chargen');

describe.skipIf(!basicLo || !basicHi || !kernal || !chargen)('2 MHz mode with the Commodore ROMs', () => {
  function typeLine(m: C128Machine, text: string): void {
    for (const ch of text) {
      const key = ch.toLowerCase();
      m.keyboard.setKey(key, true);
      run(m, 4);
      m.keyboard.setKey(key, false);
      run(m, 3);
    }
    m.keyboard.setKey('return', true);
    run(m, 4);
    m.keyboard.setKey('return', false);
    run(m, 10);
  }

  it('is turned on by FAST and off by SLOW, blanking the 40-column screen while it is on', () => {
    const m = new C128Machine(null);
    m.loadRoms(basicLo, basicHi, kernal, chargen);
    m.reset();
    run(m, 150);
    expect(m.fast2MHz).toBe(false);
    expect(new Set(m.vic.pixels).size, 'the banner').toBeGreaterThan(1);
    typeLine(m, 'FAST');
    expect(m.fast2MHz, 'FAST').toBe(true);
    expect(new Set(m.vic.pixels).size, 'blank').toBe(1);
    // BASIC still runs, and the text is still in screen memory for the TEXT overlay and OCR.
    expect(m.ocrScreenForMcp()).toContain('FAST');
    typeLine(m, 'SLOW');
    expect(m.fast2MHz, 'SLOW').toBe(false);
    expect(new Set(m.vic.pixels).size, 'the screen is back').toBeGreaterThan(1);
    m.destroy();
  });
});
