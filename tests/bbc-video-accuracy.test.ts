/**
 * The BBC Micro's video accuracy (the Display pane's High / Mid / Low): a
 * frame is drawn as the beam goes, to the character, a scanline at a time, or
 * whole at the end of the frame. A palette write the CPU makes in the middle
 * of a scanline must show from the character the beam had reached at High,
 * from that scanline at Mid, and over the whole frame at Low; a still picture
 * must come out the same at all three.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { BBC_BORDER_LEFT } from '@/machines/bbc/constants.ts';

const WHITE = 0xFFFFFFFF;
const RED = 0xFF0000FF;
const LINE_T = 40000 / 312;

/** A 32K ROM image (OS first, then the language ROM) whose OS runs, from $C000: LDA #$86 (logical 1 →
 *  physical red, 1 EOR 7); STA $FE21; then spins at $C005, where reset
 *  starts it. */
function rom(): Uint8Array {
  const r = new Uint8Array(0x8000);
  r.set([0xA9, 0x86, 0x8D, 0x21, 0xFE, 0x4C, 0x05, 0xC0], 0);
  r[0x3FFC] = 0x05; r[0x3FFD] = 0xC0;
  return r;
}

/** Mode 4 set up by hand (no MOS): 40 columns of 1-bit pixels at 1MHz, the
 *  screen at $5800 all set, logical 1 white. */
function boot(accuracy: 'high' | 'mid' | 'low'): BbcMachine {
  const m = new BbcMachine('bbc-b', null);
  m.loadROM(rom());
  m.reset();
  m.videoAccuracy = accuracy;
  const regs = [63, 40, 49, 0x24, 38, 0, 32, 34, 0, 7, 0x67, 8, 0x0B, 0x00];
  regs.forEach((v, r) => { m.crtc.selectRegister(r); m.crtc.writeRegister(v); });
  m.videoUlaControl = 0x88;
  m.palette[0] = 0;
  m.palette[1] = 7;
  m.memory.ram.fill(0xFF, 0x5800, 0x8000);
  return m;
}

/** The colour at character `c` (8 pixels, 2 wide each) of frame line `line`. */
function at(m: BbcMachine, line: number, c: number): number {
  const { borderTop, activeHeight } = m.video.layout;
  const top = borderTop + ((activeHeight - 32 * 8) >> 1);
  const px = new Uint32Array(m.video.pixels.buffer, m.video.pixels.byteOffset, m.video.pixels.length >> 2);
  return px[(top + line) * m.video.width + BBC_BORDER_LEFT + c * 16 + 4];
}

/** Stop at the first instruction boundary from line 100, cycle 40 of frame 2,
 *  run the palette write from there, and finish the frame. Returns the frame
 *  cycle (t) the stop landed on. */
function writeMidLine(m: BbcMachine): number {
  m.runUntil(2);
  m.beamTarget = { frame: 2, t: Math.floor(100 * LINE_T) + 40 };
  m.runUntil(5);
  expect(m.stopReason?.kind).toBe('beam');
  const t = m.beam().t;
  m.cpu.pc = 0xC000;
  for (let guard = 0; m.frameNumber < 3 && guard < 10; guard++) m.runUntil(1);
  return t;
}

describe('BBC video accuracy', () => {
  it('High: a mid-line palette write shows from the character the beam had reached', () => {
    const m = boot('high');
    const t = writeMidLine(m);
    // The STA's write is its 4th cycle, 5 cycles after the stop (LDA # takes
    // 2); mode 4 shows a character every two cycles.
    const first = Math.floor((t + 5 - 100 * LINE_T) / 2);
    expect(first).toBeGreaterThan(10);
    expect(at(m, 99, 30)).toBe(WHITE);
    expect(at(m, 100, first - 1)).toBe(WHITE);
    expect(at(m, 100, first)).toBe(RED);
    expect(at(m, 101, 0)).toBe(RED);
    expect(at(m, 200, 10)).toBe(RED);
  });

  it('Mid: the scanline the write lands in is drawn with it, the ones above are not', () => {
    const m = boot('mid');
    writeMidLine(m);
    expect(at(m, 99, 30)).toBe(WHITE);
    expect(at(m, 100, 0)).toBe(RED);
    expect(at(m, 200, 10)).toBe(RED);
  });

  it('Low: the whole frame is drawn at its end, with the write', () => {
    const m = boot('low');
    writeMidLine(m);
    expect(at(m, 0, 0)).toBe(RED);
    expect(at(m, 99, 30)).toBe(RED);
    expect(at(m, 200, 10)).toBe(RED);
  });

  it('a stop in the middle of a scanline leaves the picture as an unbroken run would', () => {
    const a = boot('high');
    const b = boot('high');
    for (let i = 0; i < 4; i++) a.runUntil(1);
    let n = 0;
    b.onTrap = (_pc, resume) => !resume && ++n % 97 === 0;
    for (let guard = 0; b.frameNumber < 4 && guard < 100_000; guard++) b.runUntil(1);
    expect(Array.from(b.video.pixels)).toEqual(Array.from(a.video.pixels));
  });

  it('the flash bit shows a flashing colour\'s second colour', () => {
    const m = boot('low');
    m.palette[1] = 8 | 1;             // flashing red/cyan
    m.runUntil(1);
    expect(at(m, 10, 10)).toBe(RED);
    m.videoUlaControl |= 0x01;
    m.runUntil(1);
    expect(at(m, 10, 10)).toBe(0xFFFFFF00);   // cyan, red EOR 7
  });
});

const CACHE = resolve(import.meta.dirname, '../mcp/.cache');
const haveMos = existsSync(resolve(CACHE, 'bbc-os12.rom')) && existsSync(resolve(CACHE, 'bbc-basic2.rom'));

describe.skipIf(!haveMos)('BBC video accuracy on MOS 1.20', () => {
  function booted(accuracy: 'high' | 'mid' | 'low', mode: number): BbcMachine {
    const r = new Uint8Array(0x8000);
    r.set(readFileSync(resolve(CACHE, 'bbc-os12.rom')), 0);
    r.set(readFileSync(resolve(CACHE, 'bbc-basic2.rom')), 0x4000);
    const m = new BbcMachine('bbc-b', null);
    m.loadROM(r);
    m.reset();
    m.videoAccuracy = accuracy;
    for (let i = 0; i < 150; i++) m.tick();
    for (const ch of `MODE ${mode}\n`) {
      const ev = {
        code: ch === '\n' ? 'Enter' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : '',
        key: ch === '\n' ? 'Enter' : ch, shift: false, ctrl: false, alt: false,
      };
      m.services.input.keyDown(ev);
      for (let i = 0; i < 3; i++) m.tick();
      m.services.input.keyUp(ev);
      for (let i = 0; i < 3; i++) m.tick();
    }
    for (let i = 0; i < 60; i++) m.tick();
    expect(m.video.screenMode(m)).toBe(mode);
    return m;
  }

  it.each([7, 1, 4])('a still screen in mode %i is the same picture at every accuracy', (mode) => {
    const low = booted('low', mode);
    const mid = booted('mid', mode);
    const high = booted('high', mode);
    expect(Array.from(mid.video.pixels)).toEqual(Array.from(low.video.pixels));
    expect(Array.from(high.video.pixels)).toEqual(Array.from(low.video.pixels));
  });
});
