/**
 * Mid-scanline register changes.
 *
 * Expectations come from the Altirra Hardware Reference Manual, chapter 6.10
 * ("Cycle timing"), not from the code: a CPU write on cycle N of a 114-cycle
 * line (cycle 0 = the missile DMA slot at the line's start; a store's write
 * is the last cycle of the instruction) reaches the screen at
 *
 *   colour register            colour clock 2N - 1   ("cycle 65 shows at $81")
 *   PRIOR bits 0-5             2N
 *   GRAFPn / GRAFM             2N + 1
 *   PRIOR bits 6-7             2N + 2
 *   SIZE / HITCLR              2N + 1
 *   HPOS                       2N + 3
 *
 * An object's image, once it has started shifting out, runs on whatever is
 * written next (a GRAF write only changes the latch the next image takes); an
 * image that starts on the same object ends the one before it. (SIZE and
 * HITCLR follow Altirra's GTIA, which delays them three clocks, not the
 * manual's five for SIZE.)
 *
 * and colour clock 48 is buffer x 8 (a clock is two buffer pixels), so
 * x = 2 * clock - 88. The visible window runs from clock 44 (x 0) to 212.
 */

import { describe, it, expect } from 'vitest';
import { AtariVideo } from '@/machines/atari/atari-video.ts';
import { buildAtariPalette } from '@/machines/atari/palette.ts';
import { Antic, type AnticLine } from '@/machines/atari/antic.ts';
import { Gtia } from '@/machines/atari/gtia.ts';
import { AtariMemory } from '@/machines/atari/memory.ts';
import { LineWrites, writeCutX } from '@/machines/atari/line-writes.ts';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { ATARI_OS_SIZE } from '@/machines/atari/models.ts';

const COLPM0 = 0x12;
const COLPF2 = 0x18;
const COLBK = 0x1a;
const HPOSP0 = 0x00;
const GRAFP0 = 0x0d;

/** Buffer x of a colour clock. */
const xOfClock = (clock: number) => 2 * clock - 88;

function blankLine(over: Partial<AnticLine> = {}): AnticLine {
  return {
    mode: 0, screenAddr: 0x3000, bytes: 40, row: 0, hscrollOn: false, hscrol: 0,
    dli: false, blank: true, ...over,
  };
}

function setup() {
  const video = new AtariVideo(false);
  const px = new Uint32Array(video.pixels.buffer);
  const pal = buildAtariPalette(false);
  const antic = new Antic();
  antic.dmactl = 0x22;
  antic.chbase = 0xe0;
  const gtia = new Gtia();
  const mem = new AtariMemory(0xc000);
  const writes = new LineWrites();
  /** The CPU stored `value` to GTIA register `reg` on `cycle`; the chip's
   *  registers (as at the end of the line) get it too. */
  const gtiaWrite = (reg: number, value: number, cycle: number) => {
    writes.addGtia(reg, value, gtia.regValue(reg));
    writes.stamp(cycle);
    gtia.writeReg(0xd000 + reg, value);
  };
  const anticWrite = (reg: number, value: number, cycle: number) => {
    writes.addAntic(reg, value, antic.regValue(reg));
    writes.stamp(cycle);
    antic.writeReg(0xd400 + reg, value);
  };
  const at = (x: number, y = 0) => px[y * 336 + x];
  const draw = (line: AnticLine = blankLine(), y = 0) => video.renderLine(y, line, antic, gtia, mem, writes);
  return { video, pal, antic, gtia, mem, writes, gtiaWrite, anticWrite, at, draw };
}

describe('mid-line cut positions', () => {
  it('follows the manual for each register class (write on cycle 65)', () => {
    expect(writeCutX(COLPM0, 65)).toBe(xOfClock(0x81));
    expect(writeCutX(COLBK, 65)).toBe(xOfClock(0x81));
    expect(writeCutX(0x1b, 65)).toBe(xOfClock(0x82)); // PRIOR bits 0-5
    expect(writeCutX(GRAFP0, 65)).toBe(xOfClock(0x83));
    expect(writeCutX(0x1e, 65)).toBe(xOfClock(0x84)); // PRIOR bits 6-7
    expect(writeCutX(HPOSP0, 65)).toBe(xOfClock(0x85));
    expect(writeCutX(0x08, 65)).toBe(xOfClock(0x83)); // SIZEP0
    expect(writeCutX(0x0c, 65)).toBe(xOfClock(0x83)); // SIZEM
    expect(writeCutX(0x1f, 65)).toBe(xOfClock(0x83)); // HITCLR (logged under id $1F)
  });
});

describe('mid-line colour writes (video)', () => {
  it('a COLBK write on cycle 60 colours only the pixels from clock $77 on', () => {
    const { pal, gtia, gtiaWrite, at, draw } = setup();
    gtia.colbk = 0x00;
    gtiaWrite(COLBK, 0x2a, 60);
    draw();
    const cut = xOfClock(2 * 60 - 1); // 150
    expect(cut).toBe(150);
    expect(at(0)).toBe(pal[0x00]);
    expect(at(cut - 1)).toBe(pal[0x00]);
    expect(at(cut)).toBe(pal[0x2a]);
    expect(at(335)).toBe(pal[0x2a]);
    expect(gtia.colbk).toBe(0x2a); // the register ends the line as written
  });

  it('a write in the horizontal blank before the window colours the whole line', () => {
    for (const cycle of [0, 5, 10, 22]) {
      const { pal, gtia, gtiaWrite, at, draw } = setup();
      gtiaWrite(COLBK, 0x4a, cycle);
      draw();
      expect(at(0)).toBe(pal[0x4a]);
      expect(at(100)).toBe(pal[0x4a]);
      expect(at(335)).toBe(pal[0x4a]);
      expect(gtia.colbk).toBe(0x4a);
    }
  });

  it('the first cycle that is visible leaves the leftmost pixels alone', () => {
    // Cycle 23 -> clock 45 -> x 2.
    const { pal, gtiaWrite, at, draw } = setup();
    gtiaWrite(COLBK, 0x4a, 23);
    draw();
    expect(at(1)).toBe(pal[0x00]);
    expect(at(2)).toBe(pal[0x4a]);
  });

  it('a write after the visible window changes only the next line', () => {
    const { pal, gtia, gtiaWrite, at, draw } = setup();
    gtiaWrite(COLBK, 0x6a, 107); // clock 213: just past the buffer's right edge
    draw();
    for (const x of [0, 168, 335]) expect(at(x)).toBe(pal[0x00]);
    expect(gtia.colbk).toBe(0x6a);
  });

  it('the last visible cycle still reaches the final two pixels', () => {
    // Cycle 106 -> clock 211 -> x 334.
    const { pal, gtiaWrite, at, draw } = setup();
    gtiaWrite(COLBK, 0x6a, 106);
    draw();
    expect(at(333)).toBe(pal[0x00]);
    expect(at(334)).toBe(pal[0x6a]);
    expect(at(335)).toBe(pal[0x6a]);
  });

  it('draws every segment of a rainbow with its own colour', () => {
    const { pal, gtiaWrite, at, draw } = setup();
    gtiaWrite(COLBK, 0x12, 40); // x 70
    gtiaWrite(COLBK, 0x34, 60); // x 150
    gtiaWrite(COLBK, 0x56, 80); // x 230
    draw();
    expect(at(69)).toBe(pal[0x00]);
    expect(at(70)).toBe(pal[0x12]);
    expect(at(149)).toBe(pal[0x12]);
    expect(at(150)).toBe(pal[0x34]);
    expect(at(229)).toBe(pal[0x34]);
    expect(at(230)).toBe(pal[0x56]);
    expect(at(335)).toBe(pal[0x56]);
  });

  it('a line drawn after a mid-line write starts from the final value', () => {
    const { pal, gtia, gtiaWrite, writes, video, antic, mem, at, draw } = setup();
    gtiaWrite(COLBK, 0x2a, 60);
    draw();
    writes.clear();
    video.renderLine(1, blankLine(), antic, gtia, mem, writes);
    expect(at(0, 1)).toBe(pal[0x2a]);
    expect(at(335, 1)).toBe(pal[0x2a]);
  });

  it('rewriting the value a register already holds does not split the line', () => {
    const { gtia, gtiaWrite, writes } = setup();
    gtia.colbk = 0x2a;
    gtiaWrite(COLBK, 0x2a, 60);
    expect(writes.count).toBe(0);
  });

  it('a playfield colour written mid-line recolours only the pixels after it', () => {
    const { pal, gtia, mem, gtiaWrite, at, draw } = setup();
    gtia.colpf.set([0, 0, 0x94, 0]);
    gtia.colpf[2] = 0x94;
    mem.ram.fill(0, 0x3000, 0x3028); // mode F, all bits clear: the COLPF2 field
    gtiaWrite(COLPF2, 0x36, 70); // clock 139 -> x 190
    draw(blankLine({ mode: 0x0f, blank: false }));
    expect(at(8)).toBe(pal[0x94]);
    expect(at(189)).toBe(pal[0x94]);
    expect(at(190)).toBe(pal[0x36]);
    expect(at(327)).toBe(pal[0x36]);
    expect(at(328)).toBe(pal[0x00]); // border
  });
});

describe('mid-line players, missiles and collisions', () => {
  it('a position write cuts the old image and starts the new one at clock +5', () => {
    // P0 at clock 100 (x 112..127); moved to clock 150 (x 212..227).
    const old = setup();
    old.gtia.hposp[0] = 100;
    old.gtia.grafp[0] = 0xff;
    old.gtia.colpm[0] = 0x1c;
    old.gtiaWrite(HPOSP0, 150, 40); // cut x = 4*40 - 82 = 78: before both images
    old.draw();
    expect(old.at(112)).toBe(old.pal[0x00]); // old image gone
    expect(old.at(212)).toBe(old.pal[0x1c]); // new image there

    const late = setup();
    late.gtia.hposp[0] = 100;
    late.gtia.grafp[0] = 0xff;
    late.gtia.colpm[0] = 0x1c;
    late.gtiaWrite(HPOSP0, 150, 70); // cut x = 198: between them
    late.draw();
    expect(late.at(112)).toBe(late.pal[0x1c]); // old image shows left of the cut
    expect(late.at(127)).toBe(late.pal[0x1c]);
    expect(late.at(212)).toBe(late.pal[0x1c]); // new image right of it
    expect(late.at(160)).toBe(late.pal[0x00]);
  });

  it('a GRAFP write after the player has started leaves the image shifting out alone', () => {
    // P0 at clock 144 (x 200..215) has begun by the write on cycle 72 (clock
    // 145, x 202): switching its graphics off then only changes the latch the
    // next image would take.
    const { pal, gtia, gtiaWrite, at, draw } = setup();
    gtia.hposp[0] = 144;
    gtia.grafp[0] = 0xff;
    gtia.colpm[0] = 0x1c;
    gtiaWrite(GRAFP0, 0x00, 72);
    draw();
    expect(at(199)).toBe(pal[0x00]);
    expect(at(200)).toBe(pal[0x1c]);
    expect(at(215)).toBe(pal[0x1c]);
    expect(at(216)).toBe(pal[0x00]);
  });

  it('a GRAFP write before the player starts is the graphics it takes (clock 2N + 1)', () => {
    const { pal, gtia, gtiaWrite, at, draw } = setup();
    gtia.hposp[0] = 144;
    gtia.grafp[0] = 0xff;
    gtia.colpm[0] = 0x1c;
    gtiaWrite(GRAFP0, 0x00, 70); // clock 141, x 194: before the player at x 200
    draw();
    expect(at(200)).toBe(pal[0x00]);
    expect(at(215)).toBe(pal[0x00]);
  });

  it('a player moved ahead of the beam after its first image has run shows both (multiplexing)', () => {
    // P0 at clock 60 (x 32..47) is on by cycle 40 (the write's cut is x 78);
    // moving it to clock 100 (x 112) puts a second copy ahead of the beam.
    const { pal, gtia, gtiaWrite, at, draw } = setup();
    gtia.hposp[0] = 60;
    gtia.grafp[0] = 0xff;
    gtia.colpm[0] = 0x1c;
    gtiaWrite(HPOSP0, 100, 40);
    draw();
    expect(at(32)).toBe(pal[0x1c]);
    expect(at(47)).toBe(pal[0x1c]);
    expect(at(60)).toBe(pal[0x00]);
    expect(at(112)).toBe(pal[0x1c]);
    expect(at(127)).toBe(pal[0x1c]);
  });

  it('a player moved to a place the beam has passed does not start again this line', () => {
    // P0 at clock 100 (x 112..127); on cycle 60 (cut x 158) it is moved back to
    // clock 80 (x 72): the beam is past there, so only the first image is drawn.
    const { pal, gtia, gtiaWrite, at, draw } = setup();
    gtia.hposp[0] = 100;
    gtia.grafp[0] = 0xff;
    gtia.colpm[0] = 0x1c;
    gtiaWrite(HPOSP0, 80, 60);
    draw();
    expect(at(112)).toBe(pal[0x1c]);
    expect(at(127)).toBe(pal[0x1c]);
    expect(at(72)).toBe(pal[0x00]);
    expect(at(87)).toBe(pal[0x00]);
  });

  it('a new image ends the one it starts inside', () => {
    // P0 at clock 100 (x 112..127) with all bits set. A GRAFP write of $0F on
    // cycle 50 (x 114) only loads the latch; the HPOS write on the same cycle
    // (x 118) restarts it at clock 104 (x 120): the old image is cut there
    // and the new one, with only its low nibble set, shows from x 128.
    const { pal, gtia, gtiaWrite, at, draw } = setup();
    gtia.hposp[0] = 100;
    gtia.grafp[0] = 0xff;
    gtia.colpm[0] = 0x1c;
    gtiaWrite(GRAFP0, 0x0f, 50);
    gtiaWrite(HPOSP0, 104, 50);
    draw();
    expect(at(112)).toBe(pal[0x1c]);
    expect(at(119)).toBe(pal[0x1c]);
    expect(at(120)).toBe(pal[0x00]);
    expect(at(127)).toBe(pal[0x00]);
    expect(at(128)).toBe(pal[0x1c]);
    expect(at(135)).toBe(pal[0x1c]);
    expect(at(136)).toBe(pal[0x00]);
  });

  it('a HITCLR clears the collisions made before it in the line, and keeps those after', () => {
    // Mode F, every bit set (PF2 everywhere), P0 at x 200..215.
    const setupLine = () => {
      const s = setup();
      s.mem.ram.fill(0xff, 0x3000, 0x3028);
      s.gtia.hposp[0] = 144;
      s.gtia.grafp[0] = 0xff;
      return s;
    };
    const after = setupLine();                 // HITCLR on cycle 80 (x 234): after the player
    after.gtiaWrite(0x1e, 0, 80);
    after.draw(blankLine({ mode: 0x0f, blank: false }));
    expect(after.gtia.hits[4]).toBe(0);

    const before = setupLine();                // on cycle 40 (x 74): before it
    before.gtiaWrite(0x1e, 0, 40);
    before.draw(blankLine({ mode: 0x0f, blank: false }));
    expect(before.gtia.hits[4]).toBe(0x04);
  });

  it('collisions register only for the pixels where the object was drawn', () => {
    // Mode F, every bit set (PF2 everywhere). P0 at x 200..215 is switched off
    // by a write whose cut falls after it (cycle 100 -> x 314): the whole
    // player was drawn, so P0PF2 is set - though the register ends the line 0.
    const a = setup();
    a.mem.ram.fill(0xff, 0x3000, 0x3028);
    a.gtia.hposp[0] = 144;
    a.gtia.grafp[0] = 0xff;
    a.gtiaWrite(GRAFP0, 0x00, 100);
    a.draw(blankLine({ mode: 0x0f, blank: false }));
    expect(a.gtia.hits[4]).toBe(0x04);

    // Switched off before it (cycle 40 -> x 74): never drawn, no collision.
    const b = setup();
    b.mem.ram.fill(0xff, 0x3000, 0x3028);
    b.gtia.hposp[0] = 144;
    b.gtia.grafp[0] = 0xff;
    b.gtiaWrite(GRAFP0, 0x00, 40);
    b.draw(blankLine({ mode: 0x0f, blank: false }));
    expect(b.gtia.hits[4]).toBe(0);
  });
});

describe('mid-line character set changes', () => {
  /** Mode 2 line: 40 copies of glyph 1, row 0. Glyph set A ($E000) has bit 7
   *  of row 0 set; set B ($E400) has it clear and bit 6 set. */
  function textSetup() {
    const s = setup();
    s.mem.ram.fill(0x01, 0x3000, 0x3028);
    s.mem.osRom[0xe000 - 0xd800 + 8] = 0x80;
    s.mem.osRom[0xe400 - 0xd800 + 8] = 0x40;
    s.gtia.colpf.set([0, 0x0a, 0x94, 0]);
    s.antic.chbase = 0xe0;
    return s;
  }
  const HI_ON = 0x9a; // COLPF2 hue at COLPF1 luminance

  it('CHBASE written before the glyph fetches changes the characters from there on', () => {
    // Write on cycle 50: effective two cycles later, and glyph data is
    // fetched two cycles before it is shown, so from clock 2*(50+4) = 108
    // (x 128), which is character 15's first pixel.
    const { pal, anticWrite, at, draw } = textSetup();
    anticWrite(0x09, 0xe4, 50);
    draw(blankLine({ mode: 2, blank: false }));
    // Characters 0-14 use set A (bit 7 = the character's first pixel).
    expect(at(8 + 14 * 8)).toBe(pal[HI_ON]);
    expect(at(8 + 14 * 8 + 1)).toBe(pal[0x94]);
    // Characters 15 on use set B (bit 6 = the second pixel).
    expect(at(8 + 15 * 8)).toBe(pal[0x94]);
    expect(at(8 + 15 * 8 + 1)).toBe(pal[HI_ON]);
  });

  it('a glyph is never split: the change waits for the next character boundary', () => {
    const { pal, anticWrite, at, draw } = textSetup();
    anticWrite(0x09, 0xe4, 51); // x 132, inside character 15
    draw(blankLine({ mode: 2, blank: false }));
    expect(at(8 + 15 * 8)).toBe(pal[HI_ON]); // character 15 still set A
    expect(at(8 + 16 * 8 + 1)).toBe(pal[HI_ON]); // character 16 is set B
    expect(at(8 + 16 * 8)).toBe(pal[0x94]);
  });

  it('a CHBASE write in the blank or after the last fetch leaves the line alone / changes all of it', () => {
    const early = textSetup();
    early.anticWrite(0x09, 0xe4, 10);
    early.draw(blankLine({ mode: 2, blank: false }));
    expect(early.at(8 + 1)).toBe(early.pal[HI_ON]); // set B everywhere
    expect(early.at(8)).toBe(early.pal[0x94]);

    const late = textSetup();
    late.anticWrite(0x09, 0xe4, 104);
    late.draw(blankLine({ mode: 2, blank: false }));
    expect(late.at(8 + 39 * 8)).toBe(late.pal[HI_ON]); // still set A
    expect(late.antic.chbase).toBe(0xe4);
  });
});

describe('HSCROL', () => {
  it('a write by cycle 10 shifts this line, a later one the next', () => {
    const line = (hscrol: number) => blankLine({
      mode: 0x0f, blank: false, bytes: 48, hscrollOn: true, hscrol,
    });
    const first = setup();
    first.gtia.colpf.set([0, 0, 0x94, 0]);
    first.mem.ram.fill(0, 0x3000, 0x3030);
    first.mem.ram[0x3004] = 0xff;
    first.antic.hscrol = 0;
    first.anticWrite(0x04, 4, 6);
    first.draw(line(0));
    // Mode F with HSCROL 4: the image moves right four colour clocks (8 px).
    const shifted = setup();
    shifted.gtia.colpf.set([0, 0, 0x94, 0]);
    shifted.mem.ram.fill(0, 0x3000, 0x3030);
    shifted.mem.ram[0x3004] = 0xff;
    shifted.draw(line(4));
    for (let x = 0; x < 336; x++) expect(first.at(x)).toBe(shifted.at(x));
    expect(first.antic.hscrol).toBe(4);
    expect(first.at(8)).toBe(first.pal[0x94]); // the set bits moved off x 8...
    expect(first.at(16)).toBe(first.pal[0x90]); // ...to x 16

    const late = setup();
    late.gtia.colpf.set([0, 0, 0x94, 0]);
    late.mem.ram.fill(0, 0x3000, 0x3030);
    late.mem.ram[0x3004] = 0xff;
    late.anticWrite(0x04, 4, 60);
    late.draw(line(0));
    const plain = setup();
    plain.gtia.colpf.set([0, 0, 0x94, 0]);
    plain.mem.ram.fill(0, 0x3000, 0x3030);
    plain.mem.ram[0x3004] = 0xff;
    plain.draw(line(0));
    for (let x = 0; x < 336; x++) expect(late.at(x)).toBe(plain.at(x));
    expect(late.antic.hscrol).toBe(4);
    expect(late.at(8)).toBe(late.pal[0x90]); // unshifted
  });
});

// ── Whole machine: where the CPU's store really lands ──────────────────────

function osWith(code: number[]): Uint8Array {
  const rom = new Uint8Array(ATARI_OS_SIZE);
  rom.set(code, 0x800); // $E000
  rom[0x27fc] = 0x00;
  rom[0x27fd] = 0xe0;
  return rom;
}

const NOP = 0xea;
const nops = (n: number) => new Array<number>(n).fill(NOP);

/**
 * Two lines per loop: line A syncs, runs `pad` NOPs then STA COLBK ($0E);
 * line B syncs, runs the same pad then STX COLBK ($00); JMP back. Returns the
 * rows drawn with the value they wrote, the cycle the store began on and the
 * buffer row.
 */
function runToggle(pad: number, store: 'abs' | 'indy') {
  const wsync = [0x8d, 0x0a, 0xd4];
  const stA = store === 'abs' ? [0x8d, 0x1a, 0xd0] : [0x91, 0x80];
  const stX = store === 'abs' ? [0x8e, 0x1a, 0xd0] : [0x91, 0x80];
  const code = store === 'abs'
    ? [0xa9, 0x0e, 0xa2, 0x00, ...wsync, ...nops(pad), ...stA, ...wsync, ...nops(pad), ...stX, 0x4c, 0x04, 0xe0]
    // LDA #$0E ; LDY #0 ; ... STA ($80),Y with $80/$81 = $D01A, then STA with A=0 via LDA #0
    : [0xa9, 0x0e, 0xa0, 0x00, ...wsync, ...nops(pad), ...stA, 0xa9, 0x00, ...wsync, ...nops(pad),
      ...stX, 0xa9, 0x0e, 0x4c, 0x04, 0xe0];
  const m = new AtariMachine('atari800', null, 'ntsc');
  m.services.roms.installSystemRom(osWith(code));
  m.reset();
  m.memory.ram[0x80] = 0x1a; // the ($80),Y pointer: COLBK
  m.memory.ram[0x81] = 0xd0;
  // Capture each COLBK store's start (the core advances tStates afterwards).
  const starts: number[] = [];
  const gw = m.gtia.writeReg.bind(m.gtia);
  m.gtia.writeReg = (addr: number, v: number) => { if ((addr & 0x1f) === COLBK) starts.push(m.cpu.tStates); gw(addr, v); };
  const rows = new Map<number, { cycle: number; value: number }>();
  const rl = m.video.renderLine.bind(m.video);
  m.video.renderLine = (y, line, an, gt, mem, w) => {
    if (w !== undefined && w.count > 0) rows.set(y, { cycle: w.cycle[0], value: w.value[0] });
    rl(y, line, an, gt, mem, w);
  };
  m.tick();
  m.tick();
  return { m, rows, starts };
}

describe('mid-line writes through the machine', () => {
  const rowColour = (m: AtariMachine, y: number, x: number) => new Uint32Array(m.pixels.buffer)[y * 336 + x];

  it('stamps an absolute store with its last cycle and splits the row there', () => {
    const { m, rows, starts } = runToggle(20, 'abs');
    try {
      expect(starts.length).toBeGreaterThan(100);
      const pal = m.video.paletteTable;
      // Find a steady-state row that wrote $0E (the previous line left $00).
      const y = [...rows].filter(([r, e]) => r > 20 && r < 200 && e.value === 0x0e).map(([r]) => r)[0];
      const e = rows.get(y)!;
      // Every store began (e.cycle - 3) cycles into its line: STA abs is four
      // cycles, its write the fourth.
      expect(e.cycle).toBeGreaterThan(30);
      expect(e.cycle).toBeLessThan(100);
      const cut = 4 * e.cycle - 90;
      expect(rowColour(m, y, cut - 1)).toBe(pal[0x00]);
      expect(rowColour(m, y, cut)).toBe(pal[0x0e]);
      // The next line (STX writes $00) is the mirror image.
      const e2 = rows.get(y + 1)!;
      expect(e2.value).toBe(0x00);
      const cut2 = 4 * e2.cycle - 90;
      expect(rowColour(m, y + 1, cut2 - 1)).toBe(pal[0x0e]);
      expect(rowColour(m, y + 1, cut2)).toBe(pal[0x00]);
    } finally {
      m.destroy();
    }
  });

  it('puts an absolute store on cycle start + 3 and an indirect-indexed one on start + 5', () => {
    for (const store of ['abs', 'indy'] as const) {
      const { m, rows, starts } = runToggle(20, store);
      try {
        const need = store === 'abs' ? 3 : 5;
        // The line a store belongs to starts on the machine's line grid.
        const grid = (m as unknown as { frameBase: number }).frameBase;
        const perLine = 114;
        const lineOf = (t: number) => ((t - grid) % perLine + perLine) % perLine;
        const y = [...rows.keys()].find(r => r > 20 && r < 200)!;
        const e = rows.get(y)!;
        const startCycles = starts.map(t => lineOf(t));
        expect(startCycles).toContain(e.cycle - need);
      } finally {
        m.destroy();
      }
    }
  });

  it('a store in the horizontal blank (cycle < 23) changes the whole row', () => {
    const { m, rows } = runToggle(3, 'abs'); // the store lands on cycle ~9
    try {
      const pal = m.video.paletteTable;
      const y = [...rows].filter(([r, e]) => r > 20 && r < 200 && e.value === 0x0e).map(([r]) => r)[0];
      expect(rows.get(y)!.cycle).toBeLessThan(22);
      expect(rowColour(m, y, 0)).toBe(pal[0x0e]);
      expect(rowColour(m, y, 335)).toBe(pal[0x0e]);
    } finally {
      m.destroy();
    }
  });

  it('a store after the visible window leaves its own row alone and shows on the next', () => {
    const { m, rows } = runToggle(48, 'abs'); // store lands past cycle 107
    try {
      const pal = m.video.paletteTable;
      const y = [...rows].filter(([r, e]) => r > 20 && r < 200 && e.value === 0x0e).map(([r]) => r)[0];
      expect(rows.get(y)!.cycle).toBeGreaterThanOrEqual(107);
      expect(rowColour(m, y, 0)).toBe(pal[0x00]);
      expect(rowColour(m, y, 335)).toBe(pal[0x00]);
      expect(rowColour(m, y + 1, 0)).toBe(pal[0x0e]);
      expect(rowColour(m, y + 1, 335)).toBe(pal[0x0e]);
    } finally {
      m.destroy();
    }
  });
});
