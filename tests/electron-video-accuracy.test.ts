/**
 * The Electron's video accuracy (the Display pane's High / Mid / Low). The
 * ULA shows the 640-pixel line during the first 80 CPU cycles of its 128 (40 µs
 * at 16 MHz: 8 pixels a cycle), so at High a write the CPU makes to the palette,
 * the mode or the screen memory must show from the pixel the beam had reached;
 * at Mid from the start of its scanline; at Low (the picture is drawn at the
 * end of the frame) over the whole frame. A still picture must come out the
 * same at all three.
 *
 * The programs are hand-assembled; the raster split is the one the real
 * hardware gives programs: the 50 Hz real-time-clock interrupt at line 100.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ElectronMachine } from '@/machines/electron/electron-machine.ts';
import { ELECTRON_BORDER_LEFT, ELECTRON_BORDER_TOP, ELECTRON_SCREEN_WIDTH } from '@/machines/electron/constants.ts';

const WHITE = 0xFFFFFFFF;
const RED = 0xFF0000FF;
const BLACK = 0xFF000000;
type Accuracy = 'high' | 'mid' | 'low';

function makeRom(code: number[], irqCode: number[]): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom.set(code, 0x4000);
  rom.set(irqCode, 0x4100);
  rom[0x4000 + 0x3FFC] = 0x00; rom[0x4000 + 0x3FFD] = 0xC0;
  rom[0x4000 + 0x3FFE] = 0x00; rom[0x4000 + 0x3FFF] = 0xC1;
  return rom;
}

/** Pen 8 (pixel 1) white, `mode`, enable the `mask` interrupts, then spin. */
function init(mode: number, mask: number): number[] {
  return [
    0x78,                                // C000 SEI
    0xA9, 0xBB, 0x8D, 0x08, 0xFE,        // C001 LDA #$BB : STA $FE08
    0xA9, 0xFB, 0x8D, 0x09, 0xFE,        // C006 LDA #$FB : STA $FE09
    0xA9, mode << 3, 0x8D, 0x07, 0xFE,   // C00B LDA #mode : STA $FE07
    0xA9, mask, 0x8D, 0x00, 0xFE,        // C010 LDA #mask : STA $FE00
    0x58,                                // C015 CLI
    0x4C, 0x16, 0xC0,                    // C016 JMP $C016
  ];
}

/** IRQ: the 50 Hz clock (status bit 3) writes FE08 = $FF (pixel 1 red) at
 *  $C10F; display end (bit 2) writes it back to white. */
const PALETTE_IRQ = [
  0x48,                                  // C100 PHA
  0xAD, 0x00, 0xFE,                      // C101 LDA $FE00
  0x29, 0x08,                            // C104 AND #$08
  0xF0, 0x0C,                            // C106 BEQ $C114
  0xA9, 0x20, 0x8D, 0x05, 0xFE,          // C108 LDA #$20 : STA $FE05   clear the clock interrupt
  0xA9, 0xFF,                            // C10D LDA #$FF
  0x8D, 0x08, 0xFE,                      // C10F STA $FE08
  0x68, 0x40,                            // C112 PLA : RTI
  0xA9, 0x10, 0x8D, 0x05, 0xFE,          // C114 LDA #$10 : STA $FE05   clear display end
  0xA9, 0xBB, 0x8D, 0x08, 0xFE,          // C119 LDA #$BB : STA $FE08   white again
  0x68, 0x40,                            // C11E PLA : RTI
];

const px = (m: ElectronMachine, x: number, y: number): number =>
  new Uint32Array(m.pixels.buffer)[(ELECTRON_BORDER_TOP + y) * ELECTRON_SCREEN_WIDTH + ELECTRON_BORDER_LEFT + x];

function machine(code: number[], irq: number[], accuracy: Accuracy): ElectronMachine {
  const m = new ElectronMachine('electron', null);
  m.loadROM(makeRom(code, irq));
  m.reset();
  m.videoAccuracy = accuracy;
  return m;
}

/** Run until the instruction at `pc` is about to start; returns the cycle it
 *  starts on and the start of the line it is in. */
function stopAt(m: ElectronMachine, pc: number): { start: number; lineStart: number } {
  m.breakpoints.add(pc);
  m.runUntil(3);
  expect(m.stopReason?.kind).toBe('breakpoint');
  const start = m.beam().t;                    // cycles into the frame
  m.breakpoints.delete(pc);
  return { start, lineStart: Math.floor(start / 128) * 128 };
}

describe('Electron video accuracy: a palette write from the line-100 clock interrupt (mode 4)', () => {
  function split(accuracy: Accuracy, mode = 4) {
    const m = machine(init(mode, 0x0C), PALETTE_IRQ, accuracy);
    m.memory.ram.fill(0xFF, 0x3000, 0x8000);              // every pixel is pen 8
    const at = stopAt(m, 0xC10F);
    while (m.frameNumber < 1) m.runUntil(1);
    return { m, ...at };
  }

  it('High: the write shows from the pixel the beam had reached (8 pixels a cycle)', () => {
    const { m, start, lineStart } = split('high');
    // The clock interrupt is raised at the start of line 100 and STA abs
    // writes on its 4th cycle, 3 after it starts.
    expect(lineStart).toBe(100 * 128);
    const x = (start + 3 - lineStart) * 8;
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(640);                     // mode 4's RAM is not held up by the display
    expect(px(m, 5, 99)).toBe(WHITE);
    expect(px(m, 639, 99)).toBe(WHITE);
    expect(px(m, x - 1, 100)).toBe(WHITE);
    expect(px(m, x, 100)).toBe(RED);
    expect(px(m, 639, 100)).toBe(RED);
    expect(px(m, 0, 101)).toBe(RED);
    expect(px(m, 0, 255)).toBe(RED);
    m.destroy();
  });

  it('Mid: the scanline the write lands in is drawn with it, the ones above are not', () => {
    const { m } = split('mid');
    expect(px(m, 639, 99)).toBe(WHITE);
    expect(px(m, 0, 100)).toBe(RED);
    expect(px(m, 639, 100)).toBe(RED);
    expect(px(m, 0, 255)).toBe(RED);
    m.destroy();
  });

  it('Low: the whole frame is drawn at its end with the palette as it is then (display end put it back)', () => {
    const { m } = split('low');
    for (const y of [0, 99, 100, 101, 255]) {
      expect(px(m, 0, y)).toBe(WHITE);
      expect(px(m, 639, y)).toBe(WHITE);
    }
    m.destroy();
  });
});

describe('Electron video accuracy: the same palette write in mode 0', () => {
  it('High: the interrupt stack pushes wait out the display fetch, so the write lands after line 100 is shown', () => {
    // In modes 0-3 a RAM access waits for the ULA's fetch (the first 80 cycles
    // of the line), so the clock handler's PHA, and so its palette write, come
    // after the line's pixels have gone out: line 100 is white, 101 red.
    const m = machine(init(0, 0x0C), PALETTE_IRQ, 'high');
    m.memory.ram.fill(0xFF, 0x3000, 0x8000);
    const { start, lineStart } = stopAt(m, 0xC10F);
    while (m.frameNumber < 1) m.runUntil(1);
    expect((start + 3 - lineStart) * 8).toBeGreaterThanOrEqual(640);
    expect(px(m, 639, 99)).toBe(WHITE);
    expect(px(m, 0, 100)).toBe(WHITE);
    expect(px(m, 639, 100)).toBe(WHITE);
    expect(px(m, 0, 101)).toBe(RED);
    expect(px(m, 639, 101)).toBe(RED);
    m.destroy();
  });

  it('Mid draws line 100 after the write, so it is red', () => {
    const m = machine(init(0, 0x0C), PALETTE_IRQ, 'mid');
    m.memory.ram.fill(0xFF, 0x3000, 0x8000);
    while (m.frameNumber < 1) m.runUntil(1);
    expect(px(m, 639, 99)).toBe(WHITE);
    expect(px(m, 0, 100)).toBe(RED);
    m.destroy();
  });
});

describe('Electron video accuracy: a screen-memory write in mode 4 (RAM is not held up by the display)', () => {
  // Mode 4 line 100 is character row 12, line 4: bytes from $3000 + 12*320 + 4,
  // eight apart per column, each column 16 pixels. The 50 Hz interrupt writes
  // $00 to columns 2 and 30 of that line. By the time the CPU gets there (a
  // few dozen cycles into the line) the beam is past column 2 (pixels 32-47)
  // but not yet at column 30 (pixels 480-495, cycle 60).
  const LINE_100 = 0x3000 + 12 * 320 + 4;
  const col = (c: number): number[] => [0x8D, (LINE_100 + c * 8) & 0xFF, (LINE_100 + c * 8) >> 8];
  const IRQ = [
    0x48,                                       // C100 PHA
    0xA9, 0x20, 0x8D, 0x05, 0xFE,               // C101 clear the clock interrupt
    0xA9, 0x00,                                 // C106 LDA #$00
    ...col(2),                                  // STA column 2
    ...col(30),                                 // STA column 30
    0x68, 0x40,                                 // PLA : RTI
  ];

  function frame(accuracy: Accuracy): ElectronMachine {
    const m = machine(init(4, 0x08), IRQ, accuracy);
    m.memory.ram.fill(0xFF, 0x3000, 0x8000);
    while (m.frameNumber < 1) m.runUntil(1);
    return m;
  }

  it('High: a column the beam has passed keeps the old byte, one ahead of it shows the new', () => {
    const m = frame('high');
    expect(px(m, 2 * 16 + 3, 100)).toBe(WHITE);
    expect(px(m, 30 * 16 + 3, 100)).toBe(BLACK);
    expect(px(m, 30 * 16 + 3, 99)).toBe(WHITE);
    m.destroy();
  });

  it('Mid and Low: the line is drawn after the write, so both columns are new', () => {
    for (const accuracy of ['mid', 'low'] as const) {
      const m = frame(accuracy);
      expect(px(m, 2 * 16 + 3, 100), accuracy).toBe(BLACK);
      expect(px(m, 30 * 16 + 3, 100), accuracy).toBe(BLACK);
      expect(px(m, 30 * 16 + 3, 99), accuracy).toBe(WHITE);
      m.destroy();
    }
  });
});

describe('Electron video accuracy: a still picture', () => {
  // Writes the palette register it already holds, over and over, so High draws
  // the line in short pieces (7 cycles, 56 pixels apart: through the middle of
  // the 16-pixel bytes of modes 4-6) and must come out as the one-piece picture.
  const SAME_WRITES = [
    0xA9, 0xBB,                                  // C000 LDA #$BB
    0x8D, 0x08, 0xFE,                            // C002 STA $FE08
    0x4C, 0x02, 0xC0,                            // C005 JMP $C002
  ];

  function still(mode: number, accuracy: Accuracy): Uint32Array {
    const m = machine(SAME_WRITES, [0x40], accuracy);
    let seed = 12345 + mode;
    for (let a = 0x3000; a < 0x8000; a++) { seed = (seed * 1103515245 + 12345) >>> 0; m.memory.ram[a] = seed >> 16; }
    for (let r = 0; r < 8; r++) m.memory.writeByte(0xFE08 + r, r === 0 ? 0xBB : 0x37 * r);
    m.memory.writeByte(0xFE07, mode << 3);
    m.runUntil(1);
    m.runUntil(1);
    const out = new Uint32Array(m.pixels.buffer.slice(0));
    m.destroy();
    return out;
  }

  it.each([0, 1, 2, 3, 4, 5, 6])('mode %i is the same picture at High, Mid and Low', (mode) => {
    const low = still(mode, 'low');
    expect(low.some(p => p !== BLACK)).toBe(true);
    expect(Array.from(still(mode, 'mid'))).toEqual(Array.from(low));
    expect(Array.from(still(mode, 'high'))).toEqual(Array.from(low));
  });
});

const CACHE = resolve(import.meta.dirname, '../mcp/.cache');
const haveRoms = ['electron-basic.rom', 'electron-os.rom'].every(r => existsSync(resolve(CACHE, r)));

describe.skipIf(!haveRoms)('Electron video accuracy on the real OS', () => {
  function booted(accuracy: Accuracy, mode: number): Uint32Array {
    const rom = new Uint8Array(0x8000);
    rom.set(readFileSync(resolve(CACHE, 'electron-basic.rom')), 0);
    rom.set(readFileSync(resolve(CACHE, 'electron-os.rom')), 0x4000);
    const m = new ElectronMachine('electron', null);
    m.loadROM(rom);
    m.reset();
    m.videoAccuracy = accuracy;
    for (let i = 0; i < 200; i++) m.tick();
    for (const ch of `MODE ${mode}\nCOLOUR 2\nPRINT "ELECTRON"\n`) {
      const ev = {
        code: ch === '\n' ? 'Enter' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : '',
        key: ch === '\n' ? 'Enter' : ch, shift: false, ctrl: false, alt: false,
      };
      m.services.input.keyDown(ev);
      for (let i = 0; i < 3; i++) m.tick();
      m.services.input.keyUp(ev);
      for (let i = 0; i < 3; i++) m.tick();
    }
    for (let i = 0; i < 80; i++) m.tick();
    expect(m.ula.dispMode).toBe(mode);
    const out = new Uint32Array(m.pixels.buffer.slice(0));
    m.destroy();
    return out;
  }

  it.each([6, 1, 4, 0])('a still BASIC screen in mode %i is the same picture at every accuracy', (mode) => {
    const low = booted('low', mode);
    expect(low.filter(p => p !== BLACK).length).toBeGreaterThan(100);
    expect(Array.from(booted('mid', mode))).toEqual(Array.from(low));
    expect(Array.from(booted('high', mode))).toEqual(Array.from(low));
  }, 60_000);
});
