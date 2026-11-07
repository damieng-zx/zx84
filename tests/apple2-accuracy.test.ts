/**
 * Apple II accuracy work: double lo-res, the 65C02 parts per model, the game
 * connector's utility strobe, the mouse as a pair of paddles. No ROM needed.
 */

import { describe, it, expect } from 'vitest';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';
import { Apple2Video, textRowBase, hiresRowBase, type Apple2VideoState } from '@/machines/apple2/apple2-video.ts';
import { Apple2eCharset } from '@/machines/apple2/apple2-charset.ts';
import { Apple2Paddles } from '@/machines/apple2/apple2-paddles.ts';
import { APPLE2_MOUSE_PADDLES } from '@/machines/apple2/services/input.ts';
import { APPLE2_BORDER_LEFT, APPLE2_BORDER_TOP, APPLE2_SCREEN_WIDTH } from '@/machines/apple2/constants.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import type { Apple2Model } from '@/machines/apple2/models.ts';

// ── Double lo-res ───────────────────────────────────────────────────────────

const px = (v: Apple2Video, x: number, y: number): number =>
  new Uint32Array(v.pixels.buffer)[(APPLE2_BORDER_TOP + y) * APPLE2_SCREEN_WIDTH + APPLE2_BORDER_LEFT + x];

function dloresState(ram: Uint8Array, aux: Uint8Array | null, over: Partial<Apple2VideoState> = {}): Apple2VideoState {
  return {
    ram, aux, textMode: false, mixed: false, page2: false, hires: false, col80: true, dhires: true,
    charset: new Apple2eCharset(), flashPhase: false, mode: 'ntsc', ...over,
  };
}

/** A page where line group `row` has main nibbles (low, high) at column `col`. */
function put(mem: Uint8Array, row: number, col: number, low: number, high: number): void {
  mem[textRowBase('page1', row) + col] = (high << 4) | low;
}

describe('double lo-res', () => {
  const lores = (n: number): number => {
    // The colour a main-memory nibble `n` shows: read it off a 40-column lores screen.
    const v = new Apple2Video();
    const ram = new Uint8Array(0x10000);
    put(ram, 0, 0, n, n);
    v.render(dloresState(ram, null, { col80: false, dhires: false }));
    return px(v, 0, 0);
  };

  it('is 80 blocks across: auxiliary RAM left of main in each pair, seven pixels each', () => {
    const v = new Apple2Video();
    const ram = new Uint8Array(0x10000);
    const aux = new Uint8Array(0x10000);
    put(aux, 0, 3, 0, 0);                          // black
    put(ram, 0, 3, 15, 15);                        // white
    put(aux, 0, 4, 0, 0);
    put(ram, 0, 4, 0, 0);
    v.render(dloresState(ram, aux));
    for (let x = 0; x < 7; x++) expect(px(v, 3 * 14 + x, 0), `aux dot ${x}`).toBe(lores(0));
    for (let x = 7; x < 14; x++) expect(px(v, 3 * 14 + x, 0), `main dot ${x}`).toBe(lores(15));
    expect(px(v, 4 * 14, 0)).toBe(lores(0));
  });

  it('shows an auxiliary nibble as the colour of that nibble rotated left one place', () => {
    // Auxiliary nibble $1 looks like main nibble $2, $4 like $8, $8 like $1 (it
    // rotates round), $9 like $3 and $F like $F.
    const cases: [number, number][] = [[1, 2], [2, 4], [4, 8], [8, 1], [9, 3], [5, 10], [15, 15], [0, 0], [7, 14], [14, 13]];
    for (const [aux, same] of cases) {
      const v = new Apple2Video();
      const ram = new Uint8Array(0x10000);
      const a = new Uint8Array(0x10000);
      put(a, 0, 0, aux, aux);
      v.render(dloresState(ram, a));
      expect(px(v, 0, 0), `aux ${aux}`).toBe(lores(same));
    }
  });

  it('takes the low nibble for the top four lines of a block and the high nibble for the bottom four', () => {
    const v = new Apple2Video();
    const ram = new Uint8Array(0x10000);
    const aux = new Uint8Array(0x10000);
    put(ram, 1, 5, 6, 12);
    put(aux, 1, 5, 3, 9);                          // shown as 6 and 3
    v.render(dloresState(ram, aux));
    for (const y of [8, 9, 10, 11]) {
      expect(px(v, 5 * 14 + 8, y)).toBe(lores(6));
      expect(px(v, 5 * 14 + 1, y)).toBe(lores(6));   // aux 3 -> 6
    }
    for (const y of [12, 13, 14, 15]) {
      expect(px(v, 5 * 14 + 8, y)).toBe(lores(12));
      expect(px(v, 5 * 14 + 1, y)).toBe(lores(3));   // aux 9 -> 3
    }
  });

  it('needs both 80COL and AN3 off: otherwise it is ordinary lores, main RAM only', () => {
    for (const over of [{ col80: false }, { dhires: false }, { col80: false, dhires: false }]) {
      const v = new Apple2Video();
      const ram = new Uint8Array(0x10000);
      const aux = new Uint8Array(0x10000);
      put(ram, 0, 0, 6, 6);
      put(aux, 0, 0, 15, 15);
      v.render(dloresState(ram, aux, over));
      for (let x = 0; x < 14; x++) expect(px(v, x, 0), JSON.stringify(over)).toBe(lores(6));
    }
  });

  it('reads black on the auxiliary side when there is no auxiliary RAM', () => {
    const v = new Apple2Video();
    const ram = new Uint8Array(0x10000);
    put(ram, 0, 0, 6, 6);
    v.render(dloresState(ram, null));
    expect(px(v, 0, 0)).toBe(lores(0));
    expect(px(v, 8, 0)).toBe(lores(6));
  });

  it('uses the second page with PAGE2', () => {
    const v = new Apple2Video();
    const ram = new Uint8Array(0x10000);
    ram[textRowBase('page2', 0)] = 0x0A;
    v.render(dloresState(ram, null, { page2: true }));
    expect(px(v, 7, 0)).toBe(lores(10));
  });

  it('shows through the machine at every video accuracy, mixed with text below', () => {
    for (const accuracy of ['low', 'mid', 'high'] as const) {
      const m = new Apple2Machine('apple2e', null);
      try {
        m.prepare({ get: <T>(key: string, fallback: T): T => (key === 'scanline-accuracy' ? accuracy as T : key === 'apple2-video' ? 'ntsc' as T : fallback) });
        m.loadROM(new Uint8Array(0x4000));
        m.reset();
        m.applySettings({ get: <T>(key: string, fallback: T): T => (key === 'scanline-accuracy' ? accuracy as T : key === 'apple2-video' ? 'ntsc' as T : fallback) });
        const mmu = m.mmu;
        // DLORES: 80COL on, graphics, lores, AN3 off; mixed so the last rows stay text.
        m.memory.writeByte(0xC00D, 0);
        m.textMode = false; m.hires = false; m.mixed = true; m.dhires = true;
        mmu.store80 = false;
        m.memory.ram[textRowBase('page1', 0)] = 0x0F;     // main: white
        mmu.aux[textRowBase('page1', 0)] = 0x08;          // aux 8 shows as colour 1
        m.runUntil(1);
        const v = new Uint32Array(m.pixels.buffer);
        const at = (x: number, y: number): number => v[(APPLE2_BORDER_TOP + y) * APPLE2_SCREEN_WIDTH + APPLE2_BORDER_LEFT + x];
        expect(at(8, 0), accuracy).toBe(0xFFFFFFFF);
        expect(at(0, 0), accuracy).toBe(0xFFAA22DD);     // lores colour 1
        expect(at(8, 4), accuracy).toBe(0xFF000000);      // the high nibble is 0
      } finally { m.destroy(); }
    }
  });
});

describe('double hi-res dots carry the same colour as the lores nibble on the same dot clock', () => {
  // A double hi-res line repeats a four-dot group; the same four dots are what
  // a lores nibble puts on the screen (bit n of the nibble on every dot whose
  // number mod 4 is n), so the decoded colour of a half-lit group must be the
  // lores colour of that nibble. Nibbles with two adjacent bits lit are full
  // chroma ($3 purple, $6 blue, $9 orange, $C green).
  it('decodes the four-dot colours as the lores palette', () => {
    const loresColour = (n: number): number[] => {
      const v = new Apple2Video();
      const ram = new Uint8Array(0x10000);
      put(ram, 0, 0, n, n);
      v.render(dloresState(ram, null, { col80: false, dhires: false }));
      const c = px(v, 0, 0);
      return [c & 255, (c >> 8) & 255, (c >> 16) & 255];
    };
    for (const n of [3, 6, 9, 12]) {
      const v = new Apple2Video();
      const ram = new Uint8Array(0x10000);
      const aux = new Uint8Array(0x10000);
      const y = 40;
      const base = hiresRowBase('page1', y);
      for (let c = 0; c < 40; c++) {
        let a = 0, mm = 0;
        for (let i = 0; i < 7; i++) {
          if ((n >> ((14 * c + i) & 3)) & 1) a |= 1 << i;
          if ((n >> ((14 * c + 7 + i) & 3)) & 1) mm |= 1 << i;
        }
        aux[base + c] = a; ram[base + c] = mm;
      }
      v.render(dloresState(ram, aux, { hires: true }));
      const c = px(v, 14 * 20 + 3, y);
      const got = [c & 255, (c >> 8) & 255, (c >> 16) & 255];
      const want = loresColour(n);
      for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - want[k]), `nibble ${n} channel ${k}`).toBeLessThanOrEqual(4);
    }
  });
});

// ── 65C02 parts by model ────────────────────────────────────────────────────

describe('which CPU each model has', () => {
  /** `SMB3 $EA` then `JMP *`, run to the JMP: what the byte at $EA became, and
   *  how many cycles it took. On a part without SMB the first two bytes are a
   *  one-byte NOP and another NOP ($EA), 3 cycles; on the NMOS part $B7 is the
   *  undocumented LAX zp,Y (2 bytes, 4 cycles). */
  const probe = (model: Apple2Model): { zp: number; cycles: number } => {
    const m = new Apple2Machine(model, null);
    try {
      const iie = model !== 'apple2' && model !== 'apple2-plus';
      const rom = new Uint8Array(iie ? 0x4000 : 0x3000);
      rom.set([0xB7, 0xEA, 0x4C, 0x02, 0xD0], iie ? 0x1000 : 0);
      rom[iie ? 0x3FFC : 0x2FFC] = 0x00;
      rom[iie ? 0x3FFD : 0x2FFD] = 0xD0;
      m.loadROM(rom);
      m.reset();
      m.memory.ram[0xEA] = 0x00;
      m.breakpoints.add(0xD002);
      m.runUntil(2);
      return { zp: m.memory.ram[0xEA], cycles: m.cpu.tStates };
    } finally { m.destroy(); }
  };

  it('the //c has the Rockwell R65C02: SMB3 sets bit 3 in 5 cycles', () => {
    expect(probe('apple2c')).toEqual({ zp: 0x08, cycles: 5 });
  });

  it('the Enhanced //e has the base 65C02: $B7 and $EA are two NOPs', () => {
    expect(probe('apple2e-enhanced')).toEqual({ zp: 0, cycles: 3 });
  });

  it('the NMOS models run $B7 as LAX zp,Y', () => {
    for (const model of ['apple2', 'apple2-plus', 'apple2e'] as const) {
      expect(probe(model), model).toEqual({ zp: 0, cycles: 4 });
    }
  });
});

// ── The utility strobe ──────────────────────────────────────────────────────

describe('game connector strobe ($C040)', () => {
  it('pulses on the cycle of the access, for a read or a write, anywhere in $C040-$C04F on a ][+', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      m.cpu.tStates = 1000;
      m.memory.readByte(0xC040);
      expect(m.paddles.strobeAt).toBe(1000);
      expect(m.paddles.strobes).toBe(1);
      m.cpu.tStates = 2000;
      m.memory.writeByte(0xC04B, 0);
      expect(m.paddles.strobeAt).toBe(2000);
      expect(m.paddles.strobes).toBe(2);
      expect(m.paddles.strobeLow(2000)).toBe(true);
      expect(m.paddles.strobeLow(2001)).toBe(false);
      expect(m.paddles.strobeLow(1999)).toBe(false);
    } finally { m.destroy(); }
  });

  it('falls on the access cycle of the instruction, not its first', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      const rom = new Uint8Array(0x3000);
      rom.set([0xEA, 0xEA, 0x8D, 0x40, 0xC0, 0x4C, 0x05, 0xD0], 0);   // NOP NOP STA $C040 JMP *
      rom[0x2FFC] = 0x00; rom[0x2FFD] = 0xD0;
      m.loadROM(rom);
      m.reset();
      m.breakpoints.add(0xD005);
      m.runUntil(2);
      // NOP, NOP take 4 cycles; STA abs starts at 4 and writes on its 4th: cycle 7.
      expect(m.paddles.strobeAt).toBe(7);
      // A reset puts it away.
      m.reset();
      expect(m.paddles.strobeAt).toBe(-1);
      expect(m.paddles.strobes).toBe(0);
    } finally { m.destroy(); }
  });

  it('is $C040 only on the //e, and not at all on the //c', () => {
    const e = new Apple2Machine('apple2e', null);
    const c = new Apple2Machine('apple2c', null);
    try {
      e.memory.readByte(0xC041);
      expect(e.paddles.strobes).toBe(0);
      e.memory.writeByte(0xC040, 0);
      expect(e.paddles.strobes).toBe(1);
      c.memory.readByte(0xC040);
      expect(c.paddles.strobes).toBe(0);
    } finally { e.destroy(); c.destroy(); }
  });

  it('shows in chip_state, and the video section names the byte an undriven read would see now', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      m.cpu.tStates = 3 * 65 + 40;                       // line 3, cycle 40: text column 15 of row 0
      m.memory.ram[0x400 + 15] = 0x5A;
      m.memory.writeByte(0xC040, 0);
      const chips = m.services.debug.chips?.() ?? [];
      expect(chips.map(c => c.name)).toEqual(['gameport', 'video']);
      const game = chips[0].dump();
      expect(game).toContain('pulsed 1 times, last on cycle 235');
      const video = chips[1].dump();
      expect(video).toContain('Scanner reading $040F = $5A');
      expect(video).toContain('line 3 cycle 40');
    } finally { m.destroy(); }
  });

  it('is part of a snapshot, and a state saved before it existed loads without one', () => {
    const p = new Apple2Paddles();
    p.strobe(12345);
    p.strobe(23456);
    const w = new StateWriter();
    p.saveState(w);
    const q = new Apple2Paddles();
    q.loadState(new StateReader(w.finish()));
    expect(q.strobeAt).toBe(23456);
    expect(q.strobes).toBe(2);

    // The layout before the strobe was added: the trigger time, four annunciators,
    // four positions, three buttons, two sticks' directions.
    const old = new StateWriter();
    old.f64(77);
    for (let i = 0; i < 4; i++) old.bool(false);
    for (let i = 0; i < 4; i++) old.u8(127);
    for (let i = 0; i < 3; i++) old.bool(false);
    for (let i = 0; i < 8; i++) old.bool(false);
    const r = new Apple2Paddles();
    r.strobe(5);
    r.loadState(new StateReader(old.finish()));
    expect(r.strobeAt).toBe(-1);
    expect(r.strobes).toBe(0);
  });
});

// ── The mouse as paddles ────────────────────────────────────────────────────

describe('mouse as paddles', () => {
  /** A paddle's position as the timer says it (0-255), by when it falls low. */
  function paddle(p: Apple2Paddles, n: number): number {
    p.trigger(0);
    let t = 0;
    while (p.timerHigh(n, t)) t++;
    return (t - 8) / 11;
  }

  it('is offered in the Mouse pane and drives paddles 0 and 1 from where they were', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      expect(m.descriptor.ui.mouseTypes.map(t => t.id)).toEqual([APPLE2_MOUSE_PADDLES]);
      expect(m.descriptor.ui.hiddenPanes).not.toContain('mouse-panel');
      const mice = m.services.input.mice!;
      mice.setMode(APPLE2_MOUSE_PADDLES);
      expect(paddle(m.paddles, 0)).toBe(127);
      mice.motion(10, -20, APPLE2_MOUSE_PADDLES);
      expect(paddle(m.paddles, 0)).toBe(137);
      expect(paddle(m.paddles, 1)).toBe(107);
      mice.motion(-5, 30, APPLE2_MOUSE_PADDLES);
      expect(paddle(m.paddles, 0)).toBe(132);
      expect(paddle(m.paddles, 1)).toBe(137);
    } finally { m.destroy(); }
  });

  it('stops at the ends of the range', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      const mice = m.services.input.mice!;
      mice.setMode(APPLE2_MOUSE_PADDLES);
      mice.motion(1000, -1000, APPLE2_MOUSE_PADDLES);
      expect(paddle(m.paddles, 0)).toBe(255);
      expect(paddle(m.paddles, 1)).toBe(0);
      mice.motion(-1, 1, APPLE2_MOUSE_PADDLES);
      expect(paddle(m.paddles, 0)).toBe(254);        // no wind-up beyond the end
      expect(paddle(m.paddles, 1)).toBe(1);
    } finally { m.destroy(); }
  });

  it('keeps fractions of a pixel', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      const mice = m.services.input.mice!;
      mice.setMode(APPLE2_MOUSE_PADDLES);
      for (let i = 0; i < 5; i++) mice.motion(0.3, 0, APPLE2_MOUSE_PADDLES);   // 1.5 in all
      expect(paddle(m.paddles, 0)).toBe(129);                                   // 127 + 1.5, rounded
    } finally { m.destroy(); }
  });

  it('left and right buttons are push buttons 0 and 1; the middle one does nothing', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      const mice = m.services.input.mice!;
      mice.setMode(APPLE2_MOUSE_PADDLES);
      mice.button(0, true, APPLE2_MOUSE_PADDLES);
      expect(m.memory.readByte(0xC061) & 0x80).toBe(0x80);
      expect(m.memory.readByte(0xC062) & 0x80).toBe(0);
      mice.button(2, true, APPLE2_MOUSE_PADDLES);
      expect(m.memory.readByte(0xC062) & 0x80).toBe(0x80);
      mice.button(1, true, APPLE2_MOUSE_PADDLES);
      expect(m.memory.readByte(0xC063) & 0x80).toBe(0);
      mice.button(0, false, APPLE2_MOUSE_PADDLES);
      expect(m.memory.readByte(0xC061) & 0x80).toBe(0);
      // Releasing the mouse lets go of whatever is held.
      mice.setMode(null);
      expect(m.memory.readByte(0xC062) & 0x80).toBe(0);
    } finally { m.destroy(); }
  });

  it('ignores motion for any other mode, and picks up from the joystick position when captured', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      const mice = m.services.input.mice!;
      mice.motion(50, 50, null);
      mice.motion(50, 50, 'other');
      expect(paddle(m.paddles, 0)).toBe(127);
      m.paddles.analog('x', 1, 0);                     // a gamepad pushes paddle 0 to the right
      mice.setMode(APPLE2_MOUSE_PADDLES);
      mice.motion(-5, 0, APPLE2_MOUSE_PADDLES);
      expect(paddle(m.paddles, 0)).toBe(250);
    } finally { m.destroy(); }
  });
});
