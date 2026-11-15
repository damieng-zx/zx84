/**
 * The 128's 2 MHz mode: $D030 bit 0 (in either mode: the register is in the
 * VIC-IIe, which the 64's map does not hide) doubles the 8502's speed against
 * the 1 MHz clock the other chips keep, except for the five cycles of DRAM
 * refresh in every line and for each access to the I/O page, which end on a
 * 1 MHz edge. The VIC-IIe is not switched off: it runs on and never holds the
 * CPU, but with the CPU on the bus both halves of the clock it reads what the
 * CPU has on the data bus instead of memory (the real-hardware 2mhzVIC pictures
 * are drawn this way). Programs are assembled by hand into a ROM-less machine
 * whose Z80 BIOS copies them to $1100 and starts the 8502 there
 * (`hand-bios.ts`); with the real ROMs, BASIC's FAST and SLOW turn it on and
 * off (and blank the screen themselves, through DEN).
 */

import { describe, it, expect } from 'vitest';
import { C128Machine } from '@/machines/c128/c128-machine.ts';
import { VicII } from '@/cores/vic-ii.ts';
import { VIC_PALETTE, vicBoardTiming } from '@/machines/shared/cbm/vic-ii-board.ts';
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
  it('runs the 8502 at 121 cycles to the 63 of a 1 MHz PAL line: refresh stays at 1 MHz', () => {
    const slow = rate(counter(0));
    const fast = rate(counter(1));
    expect(slow).toBeGreaterThan(1000);
    expect(fast / slow).toBeGreaterThan(1.88);
    expect(fast / slow).toBeLessThan(1.96);
  });

  it('keeps an access to the I/O page at 1 MHz', () => {
    const readIo = [0xAD, 0x20, 0xD0];                    // LDA $D020
    const pure = rate(counter(1)) / rate(counter(0));
    const io = rate(counter(1, readIo)) / rate(counter(0, readIo));
    expect(io).toBeLessThan(pure);
    expect(io).toBeGreaterThan(1.5);
  });

  it('costs a read-modify-write of an I/O register 8 cycles against 6 for one of RAM (INC $D020, INC $C000)', () => {
    const ram = rate(counter(1, [0xEE, 0x00, 0xC0]));      // INC $C000
    const io = rate(counter(1, [0xEE, 0x20, 0xD0]));       // INC $D020
    // Per iteration the loop is 5 cycles + the INC: 11 against 13 cycles (of which the I/O pair is 2 wider).
    expect(ram / io).toBeGreaterThan(1.1);
    expect(ram / io).toBeLessThan(1.25);
  });

  it('works in C64 mode too: the VIC-IIe and its $D030 are still there', () => {
    const fastMachine = machineRunning(counter(1));
    const slowMachine = machineRunning(counter(0));
    for (const m of [fastMachine, slowMachine]) {
      run(m, 3);
      m.memory.mmu.mcr |= 0x40;
      m.memory.pinsChanged();
    }
    expect(fastMachine.fast2MHz).toBe(true);
    const f0 = count(fastMachine), s0 = count(slowMachine);
    run(fastMachine, 10); run(slowMachine, 10);
    const f = (count(fastMachine) - f0) & 0xFFFF, s = (count(slowMachine) - s0) & 0xFFFF;
    expect(f / s).toBeGreaterThan(1.85);
    expect(f / s).toBeLessThan(2.0);
    fastMachine.destroy(); slowMachine.destroy();
  });

  it('does not stall the CPU for bad lines, with the display on', () => {
    const withDisplay = (d030: number): number[] => [
      0xA9, 0x1B, 0x8D, 0x11, 0xD0,                       // LDA #$1B : STA $D011   display on
      0xA9, d030, 0x8D, 0x30, 0xD0,                       // LDA #n   : STA $D030
      0xE6, 0xFB, 0xD0, 0x02, 0xE6, 0xFC, 0x4C, 0x0A, 0x11,
    ];
    const noDisplay = rate(counter(1));
    const display = rate(withDisplay(1));
    expect(display / noDisplay).toBeGreaterThan(0.97);
    // At 1 MHz the same display takes the bad lines' 43 cycles: about 5% of the frame.
    expect(rate(withDisplay(0)) / rate(counter(0))).toBeLessThan(0.96);
  });

  it('keeps the VIC-IIe running: the picture is still border and display, and the raster still counts', () => {
    const m = machineRunning([
      0xA9, 0x1B, 0x8D, 0x11, 0xD0,                       // LDA #$1B : STA $D011   display on
      0xA9, 0x02, 0x8D, 0x20, 0xD0,                       // LDA #2   : STA $D020   border red
      0xA9, 0x05, 0x8D, 0x21, 0xD0,                       // LDA #5   : STA $D021   background green
      0xA9, 0x01, 0x8D, 0x30, 0xD0,                       // LDA #1   : STA $D030
      0x4C, 0x14, 0x11,                                   // JMP *
    ]);
    run(m, 6);
    expect(m.fast2MHz).toBe(true);
    expect(m.vic.fast).toBe(true);
    const colours = new Set(m.vic.pixels);
    expect(colours.has(VIC_PALETTE[2]), 'the border').toBe(true);
    expect(colours.size, 'and not only the border').toBeGreaterThan(1);
    // The raster IRQ still comes from the beam.
    m.vic.write(0xD012, 100, m.cpu.tStates);
    m.vic.write(0xD01A, 1, m.cpu.tStates);
    run(m, 1);
    expect(m.vic.irqFlags & 1).toBe(1);
    m.destroy();
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
    expect(b.vic.fast).toBe(true);
    b.reset();
    expect(b.fast2MHz).toBe(false);
    run(b, 1);
    expect(b.vic.fast).toBe(false);
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

describe('the VIC-IIe on the CPU bus', () => {
  /** A chip that sees no memory at all (every byte reads $00), so anything it
   *  draws came from the bus. */
  function chip(): VicII {
    const timing = vicBoardTiming(false);
    const vic = new VicII({ vicRead: () => 0x00, colorRam: new Uint8Array(1024) }, timing, VIC_PALETTE);
    vic.write(0xD011, 0x1B, 0);
    vic.write(0xD016, 0x08, 0);
    vic.write(0xD020, 0, 0);
    vic.write(0xD021, 1, 0);                              // background white
    return vic;
  }
  const LINE = 0x33;                                      // the first bad line with YSCROLL 3
  const pixel = (vic: VicII, k: number, bit: number): number =>
    vic.pixels[(LINE - vic.timing.firstLine) * 384 + 32 + 8 * k + bit];

  /** One bad line's worth of bus: for character k the first half holds `opcode(k)`,
   *  the next `operand(k)` (a CPU running two-cycle instructions). */
  function busLine(vic: VicII, start: number, opcode: (k: number) => number, operand: (k: number) => number): void {
    for (let k = 0; k < 40; k++) {
      vic.putBus(2 * (start + k) + 26, opcode(k));
      vic.putBus(2 * (start + k) + 27, operand(k));
    }
  }

  it('draws the operand as pixels and the low nibble of the opcode as the colour on a bad line', () => {
    const vic = chip();
    vic.fast = true;
    const l0 = 100000;
    vic.startLine(0x30, l0);
    vic.endLine();
    const start = l0 + 63;
    vic.startLine(LINE, start);
    busLine(vic, start, k => 0xE0 | (k + 1), k => (k === 2 ? 0xA0 : 0xFF));
    vic.loadCounters();
    vic.drawTo(start + 63);
    // Character 0: all foreground in colour 1 (the opcode's low nibble), white.
    for (let b = 0; b < 8; b++) expect(pixel(vic, 0, b)).toBe(VIC_PALETTE[1]);
    // Character 1: colour 2.
    expect(pixel(vic, 1, 3)).toBe(VIC_PALETTE[2]);
    // Character 2: $A0, colour 3 where the bit is set, the background where it is not.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(b => pixel(vic, 2, b))).toEqual(
      [3, 1, 3, 1, 1, 1, 1, 1].map(c => VIC_PALETTE[c]));
  });

  it('keeps the colours of the bad line for the seven lines under it, taking only the pixels from the bus', () => {
    const vic = chip();
    vic.fast = true;
    const l0 = 100000;
    vic.startLine(0x30, l0);
    vic.endLine();
    const start = l0 + 63;
    vic.startLine(LINE, start);
    busLine(vic, start, () => 0xE7, () => 0xFF);
    vic.loadCounters();
    vic.drawTo(start + 63);
    vic.endOfLineFetches();
    vic.endLine();
    const next = start + 63;
    vic.startLine(LINE + 1, next);
    vic.loadCounters();
    busLine(vic, next, () => 0x00, () => 0x0F);           // opcode ignored off a bad line
    vic.drawTo(next + 63);
    const at = (k: number, b: number) => vic.pixels[(LINE + 1 - vic.timing.firstLine) * 384 + 32 + 8 * k + b];
    expect(at(0, 0), 'bit clear: the background').toBe(VIC_PALETTE[1]);
    expect(at(0, 7), 'bit set: the colour latched on the bad line').toBe(VIC_PALETTE[7]);
  });

  it('reads $FF where the CPU did not drive the bus', () => {
    const vic = chip();
    vic.fast = true;
    const l0 = 100000;
    vic.startLine(0x30, l0);
    vic.endLine();
    const start = l0 + 63;
    vic.startLine(LINE, start);
    vic.loadCounters();                                   // nothing was put on the bus
    vic.drawTo(start + 63);
    expect(pixel(vic, 5, 4), 'foreground of a colour nibble $F').toBe(VIC_PALETTE[15]);
  });

  it('never holds the CPU, where on the normal bus it holds it for the bad line', () => {
    const vic = chip();
    const l0 = 100000;
    vic.startLine(0x30, l0);
    vic.endLine();
    vic.startLine(LINE, l0 + 63);
    const during = l0 + 63 + 30;
    expect(vic.stealEnd(during)).toBeGreaterThan(during);
    vic.fast = true;
    expect(vic.stealEnd(during)).toBe(during);
    expect(vic.stretch(l0 + 63 + 5, l0 + 63 + 20)).toBe(0);
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

  it('is turned on by FAST and off by SLOW, blanking the 40-column screen (through DEN) while it is on', () => {
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
