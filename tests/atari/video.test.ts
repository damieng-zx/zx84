/**
 * Atari scanline renderer tests.
 *
 * Expectations are the hardware's (De Re Atari / the ANTIC and GTIA data
 * sheets), worked out by hand:
 *
 *  - Hi-res modes (2, 3, F) paint the whole playfield COLPF2; a set bit shows
 *    COLPF2's hue at COLPF1's luminance. The border outside is COLBK.
 *  - Mode 4/5 glyph bit pairs are BAK/PF0/PF1/PF2, with PF3 replacing PF2 for
 *    character codes with bit 7 set. Modes 6/7 take the colour from code bits
 *    6-7 and use a 512-byte-aligned, 64-glyph set.
 *  - Mode 8 is 10 bytes of four 2-bit pixels, each 8 buffer pixels wide.
 *  - One colour clock is two buffer pixels; HPOS 48 is the normal
 *    playfield's left edge (buffer x 8).
 *  - SIZEP 0/2 are normal width, 1 double, 3 quadruple.
 *  - PRIOR: 1 = players over playfield, 2 = P0/1 > PF > P2/3,
 *    4 = playfield over players, 8 = PF0/1 > players > PF2/3.
 */

import { describe, it, expect } from 'vitest';
import { AtariVideo } from '@/machines/atari/atari-video.ts';
import { buildAtariPalette } from '@/machines/atari/palette.ts';
import { Antic, type AnticLine } from '@/machines/atari/antic.ts';
import { Gtia } from '@/machines/atari/gtia.ts';
import { AtariMemory } from '@/machines/atari/memory.ts';

const COLBK = 0x00;
const COLPF0 = 0x28;
const COLPF1 = 0x0a;
const COLPF2 = 0x94;
const COLPF3 = 0x46;
/** A hi-res set bit: COLPF2's hue, COLPF1's luminance. */
const HIRES_ON = 0x9a;

function line(over: Partial<AnticLine>): AnticLine {
  return {
    mode: 0, screenAddr: 0x3000, bytes: 40, row: 0, hscrollOn: false, hscrol: 0,
    dli: false, blank: false, ...over,
  };
}

function setup() {
  const video = new AtariVideo(false);
  const pixels = new Uint32Array(video.pixels.buffer);
  const palette = buildAtariPalette(false);
  const antic = new Antic();
  antic.chbase = 0xe0;
  antic.dmactl = 0x22;
  const gtia = new Gtia();
  gtia.colbk = COLBK;
  gtia.colpf.set([COLPF0, COLPF1, COLPF2, COLPF3]);
  gtia.colpm.set([0x10, 0x20, 0x30, 0x50]);
  const mem = new AtariMemory(0xc000);
  /** Colour register value shown at buffer x on row 0. */
  const at = (x: number, y = 0) => pixels[y * 336 + x];
  const draw = (over: Partial<AnticLine>, y = 0) => video.renderLine(y, line(over), antic, gtia, mem);
  /** Write a byte into the OS ROM image by CPU address. */
  const rom = (addr: number, v: number) => { mem.osRom[addr - 0xd800] = v; };
  return { video, palette, antic, gtia, mem, at, draw, rom };
}

describe('atari video hi-res modes', () => {
  it('paints mode F set bits in COLPF2 hue at COLPF1 luminance on a COLPF2 field', () => {
    const { palette, mem, at, draw } = setup();
    mem.ram[0x3000] = 0x80;
    draw({ mode: 0x0f });
    expect(at(8)).toBe(palette[HIRES_ON]);
    expect(at(9)).toBe(palette[COLPF2]);
    expect(at(327)).toBe(palette[COLPF2]); // last playfield pixel
    expect(at(7)).toBe(palette[COLBK]);    // left border
    expect(at(328)).toBe(palette[COLBK]);  // right border
  });

  it('reads mode 2 glyphs from the 1K-aligned CHBASE set', () => {
    const { palette, antic, mem, at, draw, rom } = setup();
    antic.chbase = 0xe2; // the low bits are ignored in modes 2-5
    mem.ram[0x3000] = 0x01;
    rom(0xe000 + 8, 0x40); // glyph 1, row 0
    draw({ mode: 0x02 });
    expect(at(8)).toBe(palette[COLPF2]);
    expect(at(9)).toBe(palette[HIRES_ON]);
  });

  it('applies CHACTL to bit-7 characters: invert, blank, both = solid', () => {
    const { palette, antic, mem, at, draw, rom } = setup();
    mem.ram[0x3000] = 0x81;
    rom(0xe000 + 8, 0x80);

    antic.chactl = 0x00; // bit 7 ignored
    draw({ mode: 0x02 });
    expect([at(8), at(9)]).toEqual([palette[HIRES_ON], palette[COLPF2]]);

    antic.chactl = 0x02; // invert
    draw({ mode: 0x02 });
    expect([at(8), at(9)]).toEqual([palette[COLPF2], palette[HIRES_ON]]);

    antic.chactl = 0x01; // blank
    draw({ mode: 0x02 });
    expect([at(8), at(9)]).toEqual([palette[COLPF2], palette[COLPF2]]);

    antic.chactl = 0x03; // blank then invert: a solid cell
    draw({ mode: 0x02 });
    expect([at(8), at(9)]).toEqual([palette[HIRES_ON], palette[HIRES_ON]]);
  });

  it('flips the glyph vertically with CHACTL bit 2', () => {
    const { palette, antic, mem, at, draw, rom } = setup();
    mem.ram[0x3000] = 0x01;
    rom(0xe000 + 8 + 7, 0x80); // glyph 1, row 7 only
    antic.chactl = 0x04;
    draw({ mode: 0x02, row: 0 });
    expect(at(8)).toBe(palette[HIRES_ON]);
  });

  it('gives mode 3 two blank lines, and drops lower-case glyphs into them', () => {
    const { palette, mem, at, draw, rom } = setup();
    rom(0xe000 + 0x01 * 8, 0xff); // glyph $01 row 0
    rom(0xe000 + 0x61 * 8, 0xff); // glyph $61 row 0

    mem.ram[0x3000] = 0x01;
    draw({ mode: 0x03, row: 8 });
    expect(at(8)).toBe(palette[COLPF2]); // normal characters: blank descender line

    mem.ram[0x3000] = 0x61;
    draw({ mode: 0x03, row: 8 });
    expect(at(8)).toBe(palette[HIRES_ON]); // lower case: row 0 shows on scanline 8
    draw({ mode: 0x03, row: 0 });
    expect(at(8)).toBe(palette[COLPF2]);   // ... and its first two scanlines are blank
  });
});

describe('atari mode 2 scroll rows', () => {
  it('blanks scanline rows 8 and 9 and repeats the glyph rows after them', () => {
    const { palette, mem, at, draw, rom } = setup();
    mem.ram[0x3000] = 0x01;
    rom(0xe000 + 8 + 0, 0x80);   // glyph 1, row 0: leftmost pixel
    rom(0xe000 + 8 + 2, 0x40);   // row 2: second pixel
    draw({ mode: 0x02, row: 8 }, 0);
    expect(at(8, 0)).toBe(palette[COLPF2]);
    expect(at(9, 0)).toBe(palette[COLPF2]);
    draw({ mode: 0x02, row: 9 }, 1);
    expect(at(8, 1)).toBe(palette[COLPF2]);
    draw({ mode: 0x02, row: 10 }, 2);     // glyph row 2 again
    expect(at(8, 2)).toBe(palette[COLPF2]);
    expect(at(9, 2)).toBe(palette[HIRES_ON]);
  });

  it('still inverts the blanked rows for an inverse character', () => {
    const { palette, antic, mem, at, draw } = setup();
    antic.chactl = 0x02;
    mem.ram[0x3000] = 0x81;
    draw({ mode: 0x02, row: 8 }, 0);
    expect(at(8, 0)).toBe(palette[HIRES_ON]);
  });
});

describe('atari video colour text modes', () => {
  it('decodes mode 4 bit pairs, with PF3 for bit-7 characters', () => {
    const { palette, mem, at, draw, rom } = setup();
    rom(0xe000 + 8, 0x1b); // glyph 1 row 0: pairs 00 01 10 11
    mem.ram[0x3000] = 0x01;
    mem.ram[0x3001] = 0x81;
    draw({ mode: 0x04 });
    // Character 0: each colour pixel is two buffer pixels wide.
    expect([at(8), at(10), at(12), at(14)]).toEqual(
      [palette[COLBK], palette[COLPF0], palette[COLPF1], palette[COLPF2]],
    );
    // Character 1 starts eight pixels on; its 11 pair is PF3.
    expect(at(16 + 6)).toBe(palette[COLPF3]);
  });

  it('colours mode 6 from code bits 6-7 using the 512-byte-aligned set', () => {
    const { palette, antic, mem, at, draw, rom } = setup();
    antic.chbase = 0xe2; // modes 6/7: set at $E200
    rom(0xe200 + 8, 0x80); // glyph 1, row 0
    mem.ram[0x3000] = 0x41; // colour 01 -> PF1, glyph 1
    mem.ram[0x3001] = 0xc1; // colour 11 -> PF3, glyph 1
    draw({ mode: 0x06, bytes: 20 });
    expect(at(8)).toBe(palette[COLPF1]);
    expect(at(9)).toBe(palette[COLPF1]);
    expect(at(10)).toBe(palette[COLBK]);
    expect(at(24)).toBe(palette[COLPF3]); // second character, 16 pixels on
  });

  it('draws mode 7 as double-height 16-pixel characters', () => {
    const { palette, antic, mem, at, draw, rom } = setup();
    antic.chbase = 0xe2;
    rom(0xe200 + 8 + 1, 0x80); // glyph 1, row 1
    mem.ram[0x3000] = 0x01;
    mem.ram[0x3001] = 0x01;
    draw({ mode: 0x07, bytes: 20, row: 2 }); // scanline 2 shows glyph row 1
    expect(at(8)).toBe(palette[COLPF0]);
    expect(at(23)).toBe(palette[COLBK]);
    expect(at(24)).toBe(palette[COLPF0]);
  });
});

describe('atari video map modes', () => {
  it('draws mode 8 as ten bytes of four 8-pixel colour pixels', () => {
    const { palette, mem, at, draw } = setup();
    mem.ram[0x3000] = 0xc0; // 11 00 00 00
    mem.ram[0x3001] = 0x40; // 01 ...
    draw({ mode: 0x08, bytes: 10 });
    expect(at(8)).toBe(palette[COLPF2]);
    expect(at(15)).toBe(palette[COLPF2]);
    expect(at(16)).toBe(palette[COLBK]);
    expect(at(40)).toBe(palette[COLPF0]); // second byte, 32 pixels on
  });

  it('paints one-bit modes 9 and C in PF0', () => {
    const { palette, mem, at, draw } = setup();
    mem.ram[0x3000] = 0x80;
    draw({ mode: 0x09, bytes: 10 });
    expect(at(8)).toBe(palette[COLPF0]);
    expect(at(11)).toBe(palette[COLPF0]);
    expect(at(12)).toBe(palette[COLBK]);
    draw({ mode: 0x0c, bytes: 20 });
    expect(at(9)).toBe(palette[COLPF0]);
    expect(at(10)).toBe(palette[COLBK]);
  });

  it('decodes mode E bit pairs two pixels wide', () => {
    const { palette, mem, at, draw } = setup();
    mem.ram[0x3000] = 0x6c; // 01 10 11 00
    draw({ mode: 0x0e });
    expect([at(8), at(10), at(12), at(14)]).toEqual(
      [palette[COLPF0], palette[COLPF1], palette[COLPF2], palette[COLBK]],
    );
  });
});

describe('atari video playfield geometry', () => {
  it('delays an HSCROL line by two pixels per colour clock and crops the wide fetch', () => {
    const { palette, mem, at, draw } = setup();
    // A normal-width HSCROL line fetches 48 bytes centred on the window, so
    // byte 4 is the first one inside it.
    mem.ram[0x3003] = 0x01;
    mem.ram[0x3004] = 0x80;
    draw({ mode: 0x0f, bytes: 48, hscrollOn: true, hscrol: 0 });
    expect(at(8)).toBe(palette[HIRES_ON]);
    expect(at(7)).toBe(palette[COLBK]); // byte 3's last dot is outside the window

    // One colour clock later everything sits two pixels further right.
    draw({ mode: 0x0f, bytes: 48, hscrollOn: true, hscrol: 1 });
    expect(at(8)).toBe(palette[COLPF2]);
    expect(at(9)).toBe(palette[HIRES_ON]);  // byte 3's last dot, moved in
    expect(at(10)).toBe(palette[HIRES_ON]); // byte 4's first dot
  });

  it('centres a narrow playfield', () => {
    const { palette, antic, mem, at, draw } = setup();
    antic.dmactl = 0x21;
    mem.ram[0x3000] = 0x80;
    draw({ mode: 0x0f, bytes: 32 });
    expect(at(39)).toBe(palette[COLBK]);
    expect(at(40)).toBe(palette[HIRES_ON]);
  });

  it('wraps the line fetch inside its 4K block', () => {
    const { palette, mem, at, draw } = setup();
    mem.ram[0x3fff] = 0x00;
    mem.ram[0x3000] = 0x80; // where byte 1 of a line at $3FFF really comes from
    mem.ram[0x4000] = 0xff; // where it would come from without the wrap
    draw({ mode: 0x0f, screenAddr: 0x3fff });
    expect(at(16)).toBe(palette[HIRES_ON]);
    expect(at(17)).toBe(palette[COLPF2]);
  });
});

describe('atari players and missiles', () => {
  it('draws a normal player 16 pixels wide from HPOSP 48 and records P0PF', () => {
    const { palette, gtia, mem, at, draw } = setup();
    mem.ram[0x3000] = 0x55; // mode E: four PF0 pixels
    gtia.hposp[0] = 48;
    gtia.grafp[0] = 0xff;
    gtia.prior = 0x01;
    gtia.hits.fill(0);
    draw({ mode: 0x0e });
    expect(at(8)).toBe(palette[0x10]);
    expect(at(23)).toBe(palette[0x10]);
    expect(at(24)).toBe(palette[COLBK]);
    expect(gtia.hits[4]).toBe(0x01); // P0PF: PF0
  });

  it('sizes players by SIZEP: 2 is normal, 3 is quadruple', () => {
    const { palette, gtia, at, draw } = setup();
    gtia.hposp[0] = 48;
    gtia.grafp[0] = 0x80;
    gtia.sizep[0] = 2;
    draw({ mode: 0x0e });
    expect(at(9)).toBe(palette[0x10]);
    expect(at(10)).toBe(palette[COLBK]);
    gtia.sizep[0] = 3;
    draw({ mode: 0x0e });
    expect(at(15)).toBe(palette[0x10]);
    expect(at(16)).toBe(palette[COLBK]);
  });

  it('collides with a hi-res line only where a bit is set', () => {
    const { gtia, mem, draw } = setup();
    gtia.hposp[0] = 48;
    gtia.grafp[0] = 0xff;
    gtia.hits.fill(0);
    draw({ mode: 0x0f }); // empty mode-F line: only the COLPF2 field
    expect(gtia.hits[4]).toBe(0);
    mem.ram[0x3000] = 0x01;
    draw({ mode: 0x0f });
    expect(gtia.hits[4]).toBe(0x04); // P0PF: PF2
  });

  it('records player-to-player collisions both ways', () => {
    const { gtia, draw } = setup();
    gtia.hposp[0] = 48;
    gtia.hposp[1] = 50;
    gtia.grafp[0] = 0xff;
    gtia.grafp[1] = 0xff;
    gtia.hits.fill(0);
    draw({ mode: 0x0e });
    expect(gtia.hits[12]).toBe(0x02); // P0PL: P1
    expect(gtia.hits[13]).toBe(0x01); // P1PL: P0
  });

  it('draws a missile with its higher bit on the left, sized by its own SIZEM bits', () => {
    const { palette, gtia, at, draw } = setup();
    gtia.hposm[1] = 48;
    gtia.grafm = 0x08; // missile 1, left bit only
    draw({ mode: 0x0e });
    expect(at(8)).toBe(palette[0x20]);
    expect(at(9)).toBe(palette[0x20]);
    expect(at(10)).toBe(palette[COLBK]);
    gtia.sizem = 0x04; // missile 1 double width
    draw({ mode: 0x0e });
    expect(at(11)).toBe(palette[0x20]);
    expect(at(12)).toBe(palette[COLBK]);
  });

  it('turns the missiles into a COLPF3 fifth player with PRIOR bit 4', () => {
    const { palette, gtia, at, draw } = setup();
    gtia.hposm[0] = 48;
    gtia.grafm = 0x03;
    draw({ mode: 0x0e });
    expect(at(8)).toBe(palette[0x10]);
    gtia.prior = 0x10;
    draw({ mode: 0x0e });
    expect(at(8)).toBe(palette[COLPF3]);
  });

  it('ORs overlapping P0 and P1 with multicolour players (PRIOR bit 5)', () => {
    const { palette, gtia, at, draw } = setup();
    gtia.hposp[0] = 48;
    gtia.hposp[1] = 48;
    gtia.grafp[0] = 0x80;
    gtia.grafp[1] = 0x80;
    draw({ mode: 0x0e });
    expect(at(8)).toBe(palette[0x10]); // P0 hides P1
    gtia.prior = 0x20;
    draw({ mode: 0x0e });
    expect(at(8)).toBe(palette[0x10 | 0x20]);
  });
});

describe('atari GTIA priority', () => {
  /** P0 over x 8-15, P2 over x 8-23, on a field of `fieldByte` (mode E). */
  function scene(prior: number, fieldByte: number) {
    const s = setup();
    s.mem.ram.fill(fieldByte, 0x3000, 0x3028);
    s.gtia.hposp[0] = 48;
    s.gtia.grafp[0] = 0xf0;
    s.gtia.hposp[2] = 48;
    s.gtia.grafp[2] = 0xff;
    s.gtia.prior = prior;
    s.draw({ mode: 0x0e });
    return { p0: s.at(8), p2: s.at(16), palette: s.palette };
  }
  const PF0_FIELD = 0x55;
  const PF2_FIELD = 0xff;

  it('PRIOR 0: P0/P1 mix (OR) with PF0/PF1 but cover PF2/PF3', () => {
    const mixed = scene(0x00, PF0_FIELD);
    expect(mixed.p0).toBe(mixed.palette[0x10 | COLPF0]);
    expect(mixed.p2).toBe(mixed.palette[COLPF0]); // P2/P3 go under PF0/PF1
    const covered = scene(0x00, PF2_FIELD);
    expect(covered.p0).toBe(covered.palette[0x10]);
  });

  it('PRIOR 1: all players over the playfield, P0 over P2', () => {
    const { p0, p2, palette } = scene(0x01, PF0_FIELD);
    expect(p0).toBe(palette[0x10]);
    expect(p2).toBe(palette[0x30]);
  });

  it('PRIOR 2: P0/P1 over the playfield, which is over P2/P3', () => {
    const { p0, p2, palette } = scene(0x02, PF0_FIELD);
    expect(p0).toBe(palette[0x10]);
    expect(p2).toBe(palette[COLPF0]);
  });

  it('PRIOR 4: the playfield over every player', () => {
    const { p0, p2, palette } = scene(0x04, PF0_FIELD);
    expect(p0).toBe(palette[COLPF0]);
    expect(p2).toBe(palette[COLPF0]);
  });

  it('PRIOR 8: PF0/PF1 over the players, which are over PF2/PF3', () => {
    const over = scene(0x08, PF0_FIELD);
    expect(over.p0).toBe(over.palette[COLPF0]);
    expect(over.p2).toBe(over.palette[COLPF0]);
    const under = scene(0x08, PF2_FIELD);
    expect(under.p0).toBe(under.palette[0x10]);
    expect(under.p2).toBe(under.palette[0x30]);
  });
});

describe('atari line buffer', () => {
  it('replays the screen bytes the first scanline fetched on the scanlines after it', () => {
    const { palette, mem, at, draw } = setup();
    mem.ram[0x3000] = 0xc0;                     // mode D: pixels 3, 0, 0, 0
    draw({ mode: 0x0d, bytes: 40, row: 0 }, 0);
    expect(at(8, 0)).toBe(palette[COLPF2]);
    mem.ram[0x3000] = 0x00;                     // the CPU changes it mid mode line
    draw({ mode: 0x0d, bytes: 40, row: 1, fetch: false }, 1);
    expect(at(8, 1)).toBe(palette[COLPF2]);     // still the fetched byte
    draw({ mode: 0x0d, bytes: 40, row: 0 }, 2); // the next mode line fetches again
    expect(at(8, 2)).toBe(palette[COLBK]);
  });

  it('draws a scanline fetched ahead of time from that fetch, not from memory as it is at the end', () => {
    const { palette, video, antic, gtia, mem, at } = setup();
    const l = line({ mode: 0x0d, bytes: 40 });
    mem.ram[0x3000] = 0xc0;
    video.fetchScreen(l, mem);
    mem.ram[0x3000] = 0x00;                     // stored after ANTIC read it
    video.renderLine(0, l, antic, gtia, mem);
    expect(at(8)).toBe(palette[COLPF2]);
  });

  it('reads the player bytes as the line began, so a store during the line shows on the next', () => {
    const { antic, gtia, mem, video } = setup();
    antic.dmactl = 0x2a;
    antic.pmbase = 0x40;
    gtia.gractl = 0x02;
    mem.ram[0x4200 + 4] = 0x80;                 // scanlines 8 and 9, player 0
    const l = line({ mode: 0x0e, playerDma: true, missileDma: false, pmSingle: false });
    video.capturePm(8, l, antic, mem);
    mem.ram[0x4200 + 4] = 0x01;                 // the CPU rewrites it during the line
    video.renderLine(0, l, antic, gtia, mem);
    expect(gtia.grafp[0]).toBe(0x80);
  });

  it('uses the DMA state the line began with, not DMACTL as it ends', () => {
    const { antic, gtia, mem, video } = setup();
    antic.dmactl = 0x00;                        // a handler turned PM DMA off late in the line...
    antic.pmbase = 0x40;
    gtia.gractl = 0x02;
    gtia.hposp[0] = 48;
    mem.ram[0x4200 + 4] = 0x80;
    const l = line({ mode: 0x0e, playerDma: true, missileDma: false, pmSingle: false });
    video.renderLine(0, l, antic, gtia, mem);   // ...but it was on when the line began
    expect(gtia.grafp[0]).toBe(0x80);
  });
});

describe('atari player/missile DMA', () => {
  it('fetches single-line player data at PMBASE+$400 + scanline', () => {
    const { palette, antic, gtia, mem, at, draw } = setup();
    antic.dmactl = 0x3a; // DL, single-line, players, normal width
    antic.pmbase = 0x40;
    gtia.gractl = 0x02;
    gtia.hposp[0] = 48;
    mem.ram[0x4400 + 8] = 0x80; // buffer row 0 is scanline 8
    mem.ram[0x4200 + 4] = 0xff; // the double-line address must not be used
    draw({ mode: 0x0e });
    expect(gtia.grafp[0]).toBe(0x80);
    expect(at(8)).toBe(palette[0x10]);
    expect(at(10)).toBe(palette[COLBK]);
  });

  it('fetches double-line player n data at PMBASE+$200 + n*$80 + scanline/2', () => {
    const { palette, antic, gtia, mem, at, draw } = setup();
    antic.dmactl = 0x2a; // DL, double-line, players
    antic.pmbase = 0x40;
    gtia.gractl = 0x02;
    gtia.hposp[1] = 48;
    mem.ram[0x4000 + 0x200 + 0x80 + 5] = 0x80; // scanline 10 -> index 5
    draw({ mode: 0x0e }, 2);
    expect(gtia.grafp[1]).toBe(0x80);
    expect(at(8, 2)).toBe(palette[0x20]);
  });

  it('holds a VDELAY player on even scanlines at double-line resolution', () => {
    const { antic, gtia, mem, draw } = setup();
    antic.dmactl = 0x2a;
    antic.pmbase = 0x40;
    gtia.gractl = 0x02;
    gtia.vdelay = 0x10; // player 0
    mem.ram[0x4200 + 4] = 0x80; // scanlines 8 and 9
    draw({ mode: 0x0e }, 0); // scanline 8: held
    expect(gtia.grafp[0]).toBe(0x00);
    draw({ mode: 0x0e }, 1); // scanline 9: loaded
    expect(gtia.grafp[0]).toBe(0x80);
  });

  it('holds a VDELAY player on even scanlines at single-line resolution too', () => {
    const { antic, gtia, mem, draw } = setup();
    antic.dmactl = 0x3a; // DL, single-line, players
    antic.pmbase = 0x40;
    gtia.gractl = 0x02;
    gtia.vdelay = 0x10; // player 0
    mem.ram[0x4400 + 8] = 0x80; // scanline 8
    mem.ram[0x4400 + 9] = 0x40; // scanline 9
    gtia.grafp[0] = 0x11;
    draw({ mode: 0x0e }, 0); // even scanline: new data ignored
    expect(gtia.grafp[0]).toBe(0x11);
    draw({ mode: 0x0e }, 1); // odd scanline: loaded
    expect(gtia.grafp[0]).toBe(0x40);
    // Players that are not delayed are untouched by the other's VDELAY.
    gtia.vdelay = 0x20;
    mem.ram[0x4400 + 10] = 0x08;
    draw({ mode: 0x0e }, 2);
    expect(gtia.grafp[0]).toBe(0x08);
  });

  it('shows CPU-written GRAFP when GRACTL leaves DMA latching off', () => {
    const { palette, antic, gtia, mem, at, draw } = setup();
    antic.dmactl = 0x3a;
    antic.pmbase = 0x40;
    gtia.gractl = 0x00;
    gtia.hposp[0] = 48;
    gtia.grafp[0] = 0x80;
    mem.ram[0x4400 + 8] = 0x00;
    draw({ mode: 0x0e });
    expect(at(8)).toBe(palette[0x10]);
  });
});

describe('atari palette', () => {
  const rgb = (c: number) => [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff];

  it('makes hue 0 a grey ramp from black to white', () => {
    // Luma 15 (GTIA mode 9 only) is white; the colour registers' brightest,
    // 14, is a step below it.
    const p = buildAtariPalette(false);
    expect(p[0x00]).toBe(0xff000000);
    expect(rgb(p[0x0f])).toEqual([255, 255, 255]);
    let last = 0;
    for (let l = 1; l < 16; l++) {
      const [r, g, b] = rgb(p[l]);
      expect(r).toBe(g);
      expect(g).toBe(b);
      expect(r).toBeGreaterThan(last);
      last = r;
    }
  });

  it('keeps dark coloured hues visible at luminance 0', () => {
    const p = buildAtariPalette(false);
    expect(p[0x40]).not.toBe(0xff000000);
  });

  it('puts the odd luminances (GTIA mode 9 only) between their neighbours', () => {
    const p = buildAtariPalette(false);
    const grey = (v: number) => p[v] & 0xff;
    expect(grey(0x05)).toBeGreaterThan(grey(0x04));
    expect(grey(0x05)).toBeLessThan(grey(0x06));
  });

  it('shows the OS default background $94 as a blue', () => {
    const [r, g, b] = rgb(buildAtariPalette(false)[0x94]);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it('rotates the hues for PAL but not the greys', () => {
    const ntsc = buildAtariPalette(false);
    const pal = buildAtariPalette(true);
    expect(pal[0x28]).not.toBe(ntsc[0x28]);
    expect(pal[0x00]).toBe(ntsc[0x00]);
  });
});

/**
 * GTIA modes (PRIOR bits 7-6) over a hi-res line: four hi-res bits (MSB
 * first) make one pixel two colour clocks (four buffer pixels) wide, aligned
 * to the normal playfield's left edge at buffer x 8; mode 10 starts one
 * colour clock (two pixels) later.
 */
describe('atari GTIA modes', () => {
  it('mode 9 makes each nibble a luminance of the COLBK hue', () => {
    const { palette, gtia, mem, at, draw } = setup();
    gtia.colbk = 0x90;
    gtia.prior = 0x40;
    mem.ram[0x3000] = 0x5f; // nibbles 5, 15
    draw({ mode: 0x0f });
    expect(at(8)).toBe(palette[0x95]);
    expect(at(11)).toBe(palette[0x95]);
    expect(at(12)).toBe(palette[0x9f]);
  });

  it('mode 11 makes each nibble a hue at COLBK luminance, 0 forced dark', () => {
    const { palette, gtia, mem, at, draw } = setup();
    gtia.colbk = 0x06;
    gtia.prior = 0xc0;
    mem.ram[0x3000] = 0x30; // nibbles 3, 0
    draw({ mode: 0x0f });
    expect(at(8)).toBe(palette[0x36]);
    expect(at(12)).toBe(palette[0x00]);
  });

  describe('mode 10 pixels in the priority logic', () => {
    /** Mode 10 over a background field; `cells` are written from x 10 on. */
    function scene(prior: number, cells: number[]) {
      const s = setup();
      s.mem.ram.fill(0x88, 0x3000, 0x3028); // nibble 8: background
      cells.forEach((b, i) => { s.mem.ram[0x3000 + i] = b; });
      s.gtia.prior = 0x80 | prior;
      s.gtia.hits.fill(0);
      return s;
    }

    it('lets PRIOR put a PF0-3 pixel over a player, and a player over it', () => {
      const over = scene(0x04, [0x44]); // playfield over players
      over.gtia.hposp[0] = 48;
      over.gtia.grafp[0] = 0xff;         // x 8-23
      over.draw({ mode: 0x0f });
      expect(over.at(12)).toBe(over.palette[COLPF0]);
      expect(over.at(20)).toBe(over.palette[0x10]); // background there: the player shows

      const under = scene(0x01, [0x44]); // players over playfield
      under.gtia.hposp[0] = 48;
      under.gtia.grafp[0] = 0xff;
      under.draw({ mode: 0x0f });
      expect(under.at(12)).toBe(under.palette[0x10]);
    });

    it('records collisions with PF0-3 pixels, but not with P0-3 colours', () => {
      const s = scene(0x01, [0x46, 0x11]); // nibbles 4 (PF0) 6 (PF2) | 1 1 (P1 colour)
      s.gtia.hposp[0] = 48;
      s.gtia.grafp[0] = 0xff;
      s.draw({ mode: 0x0f });
      expect(s.gtia.hits[4]).toBe(0x01 | 0x04); // P0 meets PF0 and PF2

      const p = scene(0x01, [0x11]);
      p.gtia.hposp[0] = 48;
      p.gtia.grafp[0] = 0xff;
      p.draw({ mode: 0x0f });
      expect(p.gtia.hits[4]).toBe(0);
      expect(p.gtia.hits[12]).toBe(0); // and no player-player hit with the P1 colour
    });

    it('gives a P0-3 colour pixel the priority of that player against real players', () => {
      // A P0-colour pixel and a real P1 on the same pixels: P0 hides P1.
      const a = scene(0x01, [0x00]);
      a.gtia.hposp[1] = 48;
      a.gtia.grafp[1] = 0xff;
      a.draw({ mode: 0x0f });
      expect(a.at(12)).toBe(a.palette[0x10]);
      // The other way round, a real P0 hides a P1-colour pixel.
      const b = scene(0x01, [0x11]);
      b.gtia.hposp[0] = 48;
      b.gtia.grafp[0] = 0xff;
      b.draw({ mode: 0x0f });
      expect(b.at(12)).toBe(b.palette[0x10]);
    });
  });

  it('mode 10 picks the nine colour registers, one colour clock late', () => {
    const { palette, gtia, mem, at, draw } = setup();
    gtia.prior = 0x80;
    mem.ram[0x3000] = 0x15; // nibbles 1 (COLPM1), 5 (COLPF1)
    mem.ram[0x3001] = 0x80; // nibble 8 (COLBK)
    draw({ mode: 0x0f });
    expect(at(10)).toBe(palette[0x20]);    // COLPM1 from x 10
    expect(at(13)).toBe(palette[0x20]);
    expect(at(14)).toBe(palette[COLPF1]);
    expect(at(18)).toBe(palette[COLBK]);
  });
});
