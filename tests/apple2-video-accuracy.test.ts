/**
 * The Apple II's video accuracy (the Display pane's High / Mid / Low): each
 * display line's 40 columns are fetched on their own cycles (High), all at the
 * line's end (Mid), or the whole frame is drawn at its end (Low). A soft switch
 * flipped in the middle of a line must show from the column the beam had
 * reached at High, from that line at Mid, and over the whole frame at Low.
 */

import { describe, it, expect } from 'vitest';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';
import { APPLE2_BORDER_LEFT, APPLE2_BORDER_TOP, APPLE2_SCREEN_WIDTH } from '@/machines/apple2/constants.ts';
import type { SettingsView } from '@/machines/machine.ts';

const WHITE = 0xFFFFFFFF;
const BLACK = 0xFF000000;

/** Text mode over a page of inverse spaces (white cells), with hi-res on and
 *  its page blank (black), mono output. At $0300: LDA $C050 (TXTCLR: show
 *  graphics), then a JMP to itself at $0303, where the CPU waits. */
function boot(accuracy: 'high' | 'mid' | 'low'): Apple2Machine {
  const m = new Apple2Machine('apple2-plus', null);
  const view: SettingsView = { get: <T>(key: string, fallback: T): T =>
    (key === 'apple2-video' ? 'mono' : key === 'scanline-accuracy' ? accuracy : fallback) as T };
  m.applySettings(view);
  m.reset();
  m.memory.ram.fill(0x20, 0x0400, 0x0800);
  m.memory.ram.fill(0x00, 0x2000, 0x4000);
  m.memory.ram.set([0xAD, 0x50, 0xC0, 0x4C, 0x03, 0x03], 0x0300);
  m.cpu.pc = 0x0303;
  m.textMode = true;
  m.hires = true;
  return m;
}

/** The colour at column `c` of display line `y`. */
function at(m: Apple2Machine, y: number, c: number): number {
  const px = new Uint32Array(m.pixels.buffer, m.pixels.byteOffset, m.pixels.length >> 2);
  return px[(APPLE2_BORDER_TOP + y) * APPLE2_SCREEN_WIDTH + APPLE2_BORDER_LEFT + c * 14 + 3];
}

/** Stop at the first instruction boundary from line 100, cycle 40 of frame 2,
 *  run the switch read from there, and finish the frame. Returns the cycle of
 *  the line the stop landed on. */
function switchMidLine(m: Apple2Machine): number {
  m.runUntil(2);
  m.beamTarget = { frame: 2, t: 100 * 65 + 40 };
  m.runUntil(5);
  expect(m.stopReason?.kind).toBe('beam');
  const cycle = m.beam().t - 100 * 65;
  m.cpu.pc = 0x0300;
  for (let guard = 0; m.frameNumber < 3 && guard < 10; guard++) m.runUntil(1);
  return cycle;
}

describe('Apple II video accuracy', () => {
  it('High: a switch flipped mid-line shows from the column the beam had reached', () => {
    const m = boot('high');
    const stop = switchMidLine(m);
    // LDA abs reads on its 4th cycle, 3 after the stop. The columns fetched
    // on cycles 25 up to that one (the last in the same cycle, but in the
    // video's half of it, before the CPU's) are text; the rest are graphics.
    const firstGraphics = stop + 3 - 25 + 1;
    expect(firstGraphics).toBeGreaterThan(10);
    expect(at(m, 99, 30)).toBe(WHITE);
    expect(at(m, 100, firstGraphics - 1)).toBe(WHITE);
    expect(at(m, 100, firstGraphics)).toBe(BLACK);
    expect(at(m, 101, 0)).toBe(BLACK);
    expect(at(m, 190, 20)).toBe(BLACK);
  });

  it('Mid: the line the switch is flipped in is built with it, the ones above are not', () => {
    const m = boot('mid');
    switchMidLine(m);
    expect(at(m, 99, 30)).toBe(WHITE);
    expect(at(m, 100, 0)).toBe(BLACK);
    expect(at(m, 190, 20)).toBe(BLACK);
  });

  it('Low: the whole frame is drawn at its end, with the switch', () => {
    const m = boot('low');
    switchMidLine(m);
    expect(at(m, 0, 0)).toBe(BLACK);
    expect(at(m, 99, 30)).toBe(BLACK);
  });

  it('a still screen is the same picture at every accuracy', () => {
    const pics = (['low', 'mid', 'high'] as const).map((a) => {
      const m = boot(a);
      m.memory.ram.set([0x41, 0xC1, 0x01, 0x7F], 0x0400);   // a few glyphs in each style
      for (let i = 0; i < 3; i++) m.runUntil(1);
      return Array.from(m.pixels);
    });
    expect(pics[1]).toEqual(pics[0]);
    expect(pics[2]).toEqual(pics[0]);
  });

  it('a stop in the middle of a line leaves the picture as an unbroken run would', () => {
    const a = boot('high');
    const b = boot('high');
    for (let i = 0; i < 3; i++) a.runUntil(1);
    let n = 0;
    b.onTrap = (_pc, resume) => !resume && ++n % 97 === 0;
    for (let guard = 0; b.frameNumber < 3 && guard < 100_000; guard++) b.runUntil(1);
    expect(Array.from(b.pixels)).toEqual(Array.from(a.pixels));
  });
});
