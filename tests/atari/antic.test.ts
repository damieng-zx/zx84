/**
 * ANTIC display-list tests.
 *
 * Expected values come from the hardware's instruction encoding: mode 0's
 * high nibble is a 1-8 blank-line count, mode lines run for the mode's own
 * scanline height, JVB ends the list and raises VBI, and the display list
 * counter wraps inside its 1K page. The memory scan counter advances once
 * per mode line (by the bytes that line fetched) and wraps inside 4K.
 *
 * DMA cycle counts follow the ANTIC timing rules: 9 refresh cycles every
 * line, one cycle per display-list byte, the mode line's screen bytes on its
 * first scanline only, one glyph byte per character on every scanline of a
 * text mode, and five player/missile cycles on picture lines.
 */

import { describe, it, expect } from 'vitest';
import { Antic, ANTIC_FIRST_LINE } from '@/machines/atari/antic.ts';

function makeAntic(dl: number, bytes: number[], dmactl = 0x22): Antic {
  const mem = new Uint8Array(0x10000);
  for (let i = 0; i < bytes.length; i++) mem[(dl + i) & 0xFFFF] = bytes[i];
  const antic = new Antic();
  antic.read = (addr) => mem[addr & 0xFFFF];
  antic.dlist = dl;
  antic.dmactl = dmactl;
  antic.beginFrame();
  return antic;
}

/** A conventional GRAPHICS 0 list: 3 x 8 blank lines, 24 mode-2 rows, JVB. */
function graphics0List(): number[] {
  return [
    0x70, 0x70, 0x70,
    0x42, 0x00, 0x30,
    ...new Array(23).fill(0x02),
    0x41, 0x00, 0x10,
  ];
}

/** Count the mode lines an instruction displays before the next JVB. */
function modeHeight(instr: number): number {
  const antic = makeAntic(0x2000, [instr, 0x00, 0x30, 0x41, 0x00, 0x10]);
  let count = 0;
  let started = false;
  for (let line = ANTIC_FIRST_LINE; line < 80; line++) {
    const out = antic.beginLine(line);
    if (!out.blank) { started = true; count++; continue; }
    if (started) break; // the JVB after the mode
  }
  return count;
}

/** VBI is a fixed scanline: advance there and confirm it fires once. */
function expectVbiAt248(antic: Antic): void {
  expect(antic.beginLine(248).blank).toBe(true);
  expect(antic.takeVbi()).toBe(true);
  expect(antic.takeVbi()).toBe(false);
}

describe('antic blank lines', () => {
  it('treats the high nibble of a blank instruction as a 1-8 line count', () => {
    const antic = makeAntic(0x2000, [0x70, 0x20, 0x42, 0x00, 0x30, 0x41, 0x00, 0x10]);
    // $70 is eight blank lines, starting at the first display line.
    for (let line = ANTIC_FIRST_LINE; line < ANTIC_FIRST_LINE + 8; line++) {
      expect(antic.beginLine(line).blank).toBe(true);
    }
    // $20 is a blank instruction with high nibble 2, i.e. three blank lines.
    expect(antic.beginLine(ANTIC_FIRST_LINE + 8).blank).toBe(true);
    expect(antic.beginLine(ANTIC_FIRST_LINE + 9).blank).toBe(true);
    expect(antic.beginLine(ANTIC_FIRST_LINE + 10).blank).toBe(true);
    // The next line fetches the mode-2 LMS instruction.
    const mode = antic.beginLine(ANTIC_FIRST_LINE + 11);
    expect(mode.blank).toBe(false);
    expect(mode.mode).toBe(2);
    expect(mode.screenAddr).toBe(0x3000);
  });

  it('does not display anything before scanline 8', () => {
    const antic = makeAntic(0x2000, graphics0List());
    for (let line = 0; line < ANTIC_FIRST_LINE; line++) {
      expect(antic.beginLine(line).blank).toBe(true);
    }
    expect(antic.beginLine(ANTIC_FIRST_LINE).blank).toBe(true); // first $70
  });
});

describe('antic display list', () => {
  it('walks 24 mode-2 rows and raises VBI at the JVB', () => {
    const antic = makeAntic(0x2000, graphics0List());
    // Six lines into the first $70 run, plus two more $70 runs: the first
    // mode-2 row is fetched on line 32.
    for (let line = ANTIC_FIRST_LINE; line < 32; line++) {
      expect(antic.beginLine(line).blank).toBe(true);
    }

    for (let line = 32; line < 224; line++) {
      const out = antic.beginLine(line);
      expect(out.blank).toBe(false);
      expect(out.mode).toBe(2);
      expect(out.row).toBe((line - 32) % 8);
      // Every scanline of a character row shows the same 40 characters; the
      // next row starts 40 bytes on. Row n is at $3000 + 40n.
      const charRow = Math.floor((line - 32) / 8);
      expect(out.screenAddr).toBe(0x3000 + 40 * charRow);
    }

    // 24 rows of 8 lines end at line 224, where the JVB is. JVB stops the
    // display-list DMA but does not itself raise VBI; that is the fixed
    // scanline 248.
    expect(antic.beginLine(224).blank).toBe(true);
    expect(antic.takeVbi()).toBe(false);
    expect(antic.beginLine(225).blank).toBe(true);
    expectVbiAt248(antic);
  });

  it('wraps the memory scan counter inside its 4K block', () => {
    // LMS $3FD8 (40 bytes before the 4K boundary), then a second row.
    const antic = makeAntic(0x2000, [0x4f, 0xd8, 0x3f, 0x0f, 0x41, 0x00, 0x20]);
    expect(antic.beginLine(8).screenAddr).toBe(0x3fd8);
    // $3FD8 + 40 = $4000, but the counter only carries within $3000-$3FFF.
    expect(antic.beginLine(9).screenAddr).toBe(0x3000);
  });

  it('resumes from the JVB target on the next frame, not from where it stopped', () => {
    // A mode-F line, then JVB back to $2000. Pointing DLIST elsewhere first
    // proves the counter is the JVB operand, not a remembered start address.
    const antic = makeAntic(0x2000, [0x4f, 0x00, 0x30, 0x41, 0x00, 0x20]);
    expect(antic.beginLine(8).mode).toBe(0x0f);
    antic.beginLine(9); // JVB
    expect(antic.dlist).toBe(0x2000);
    antic.beginFrame();
    expect(antic.beginLine(8).screenAddr).toBe(0x3000);
  });

  it('stops fetching the display list at the vertical blank', () => {
    // A list of mode-F lines with no JVB: line 248 must be blank and must not
    // consume an instruction.
    const antic = makeAntic(0x2000, [0x4f, 0x00, 0x30]);
    for (let line = 8; line < 248; line++) antic.beginLine(line);
    const before = antic.dlist;
    expect(antic.beginLine(248).blank).toBe(true);
    expect(antic.dlist).toBe(before);
  });

  it('treats $01 as a jump that takes one blank line, not a wait', () => {
    // JMP to $2100, where a mode-F line follows.
    const antic = makeAntic(0x2000, [0x01, 0x00, 0x21]);
    const mem = new Uint8Array(0x10000);
    mem.set([0x01, 0x00, 0x21], 0x2000);
    mem.set([0x4f, 0x00, 0x30, 0x41, 0x00, 0x20], 0x2100);
    antic.read = (a) => mem[a & 0xffff];
    expect(antic.beginLine(8).blank).toBe(true);
    expect(antic.inVerticalBlank).toBe(false);
    expect(antic.beginLine(9).mode).toBe(0x0f);
  });

  it('fires the DLI of a JVB on every line it replays until the vertical blank', () => {
    const antic = makeAntic(0x2000, [0xc1, 0x00, 0x20]);
    expect(antic.beginLine(8).dli).toBe(true);
    expect(antic.beginLine(9).dli).toBe(true);
    expect(antic.beginLine(247).dli).toBe(true);
    expect(antic.beginLine(248).dli).toBe(false);
  });

  it('wraps the display-list counter inside its 1K page', () => {
    const antic = makeAntic(0x13fe, [0x00, 0x00]);
    // Patch the wrapped-to location ($1000) with a JVB.
    const mem = new Uint8Array(0x10000);
    mem[0x1000] = 0x01;
    mem[0x1001] = 0x00;
    mem[0x1002] = 0x10;
    antic.read = (addr) => {
      if (addr >= 0x13fe && addr <= 0x13ff) return 0x00;
      if (addr >= 0x1000 && addr <= 0x1002) return mem[addr];
      return 0x00;
    };
    expect(antic.beginLine(8).blank).toBe(true);
    expect(antic.beginLine(9).blank).toBe(true);
    expect(antic.beginLine(10).blank).toBe(true);
    expect(antic.takeVbi()).toBe(false);
    expectVbiAt248(antic);
  });

  it('raises the DLI bit on the last line of a mode row', () => {
    const antic = makeAntic(0x2000, [0xc2, 0x00, 0x30, 0x41, 0x00, 0x10]);
    for (let line = 8; line < 15; line++) {
      expect(antic.beginLine(line).dli).toBe(false);
    }
    const last = antic.beginLine(15);
    expect(last.dli).toBe(true);
    // The machine posts the status at ANTIC's NMI point in the line.
    expect(antic.nmist & 0x80).toBe(0);
    antic.postNmiStatus(false, last.dli);
    expect(antic.nmist & 0x80).toBe(0x80);
    // Reading NMIST is not an acknowledge: the flag stays until NMIRES.
    // (The unused low five bits read as ones.)
    expect(antic.readReg(0x0f)).toBe(0x9f);
    expect(antic.readReg(0x0f)).toBe(0x9f);
    antic.writeReg(0x0f, 0);
    expect(antic.readReg(0x0f)).toBe(0x1f);
  });
});

describe('antic mode heights', () => {
  it.each([
    ['2', 0x42, 8],
    ['3', 0x43, 10],
    ['4', 0x44, 8],
    ['5', 0x45, 16],
    ['6', 0x46, 8],
    ['7', 0x47, 16],
    ['8', 0x48, 8],
    ['9', 0x49, 4],
    ['A', 0x4a, 4],
    ['B', 0x4b, 2],
    ['C', 0x4c, 1],
    ['D', 0x4d, 2],
    ['E', 0x4e, 1],
    ['F', 0x4f, 1],
  ])('ANTIC mode %s displays %i lines', (_name, instr, expected) => {
    expect(modeHeight(instr as number)).toBe(expected);
  });

  /** Rows shown by consecutive display-list lines, until the JVB. */
  function rowsOf(antic: Antic): number[][] {
    const out: number[][] = [];
    let cur: number[] = [];
    let mode = -1;
    for (let line = 8; line < 248; line++) {
      const l = antic.beginLine(line);
      if (l.blank && antic.inVerticalBlank) break;
      if (l.row === 0 || l.mode !== mode) { if (cur.length) out.push(cur); cur = []; }
      mode = l.mode;
      cur.push(l.row);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  it('scrolls a region: starts at VSCROL, middle lines full, ends at VSCROL', () => {
    // Three mode-2 lines, VSCROL on the first two (the manual's example):
    // (8 - 3) + 8 + (3 + 1) = 17 scanlines instead of 24.
    const antic = makeAntic(0x2000, [0x62, 0x00, 0x30, 0x22, 0x02, 0x41, 0x00, 0x20]);
    antic.writeReg(0x05, 3);
    expect(rowsOf(antic)).toEqual([[3, 4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 2, 3]]);
  });

  it('counts the 4-bit row counter round when VSCROL is past the mode height', () => {
    // Mode F with VSCROL 13 entering the region: rows 13, 14, 15, 0.
    const antic = makeAntic(0x2000, [0x6f, 0x00, 0x30, 0x0f, 0x41, 0x00, 0x20]);
    antic.writeReg(0x05, 13);
    // beginLine reuses one result object, so read each row as it comes.
    const first = [8, 9, 10, 11].map(line => antic.beginLine(line).row);
    expect(first).toEqual([13, 14, 15, 0]);
  });
});

describe('antic registers and DMA', () => {
  it('reports VCOUNT as the scanline divided by two', () => {
    const antic = makeAntic(0x2000, graphics0List());
    antic.beginLine(20);
    expect(antic.readReg(0x0b)).toBe(10);
  });

  it('charges a text row its names once and its glyphs on every scanline', () => {
    const antic = makeAntic(0x2000, [0x42, 0x00, 0x30, 0x41, 0x00, 0x10]);
    antic.beginLine(8);
    // refresh 9 + instruction 1 + LMS 2 + 40 names + 40 glyph bytes.
    expect(antic.stealCycles()).toBe(9 + 1 + 2 + 40 + 40);
    antic.beginLine(9);
    // Later scanlines of the row: refresh + 40 glyph bytes only.
    expect(antic.stealCycles()).toBe(9 + 40);
  });

  it('charges a map mode its screen bytes on the first scanline only', () => {
    const antic = makeAntic(0x2000, [0x4d, 0x00, 0x30, 0x41, 0x00, 0x10]);
    antic.beginLine(8);
    expect(antic.stealCycles()).toBe(9 + 3 + 40); // ANTIC D: 40 bytes, 2 lines
    antic.beginLine(9);
    expect(antic.stealCycles()).toBe(9);
  });

  it('charges blank lines refresh only, plus the instruction byte', () => {
    const blank = makeAntic(0x2000, [0x70, 0x41, 0x00, 0x10]);
    blank.beginLine(8); // fetches the $70
    expect(blank.stealCycles()).toBe(9 + 1);
    blank.beginLine(9); // inside the $70 run
    expect(blank.stealCycles()).toBe(9);

    const off = makeAntic(0x2000, [0x42, 0x00, 0x30, 0x41, 0x00, 0x10], 0);
    off.beginLine(8);
    expect(off.stealCycles()).toBe(9);
  });

  it('adds five player/missile cycles on picture lines only', () => {
    const antic = makeAntic(0x2000, [0x70, 0x41, 0x00, 0x10], 0x2a); // DL + players + normal
    antic.beginLine(8); // fetches the $70
    antic.beginLine(9); // inside the run: no display-list fetch
    expect(antic.stealCycles()).toBe(9 + 5);
    antic.beginLine(250); // vertical blank
    expect(antic.stealCycles()).toBe(9);
  });

  it('fetches the next wider playfield on an HSCROL line', () => {
    // $5F: mode F with HSCROL at the normal width fetches 48 bytes.
    const antic = makeAntic(0x2000, [0x5f, 0x00, 0x30, 0x0f, 0x41, 0x00, 0x10]);
    const first = antic.beginLine(8);
    expect(first.bytes).toBe(48);
    expect(first.hscrollOn).toBe(true);
    // ... and the scan counter advances by the 48 bytes it fetched.
    expect(antic.beginLine(9).screenAddr).toBe(0x3000 + 48);
  });

  it('fetches 32 and 48 bytes for narrow and wide 40-byte modes', () => {
    const narrow = makeAntic(0x2000, [0x4f, 0x00, 0x30, 0x41, 0x00, 0x10], 0x21);
    expect(narrow.beginLine(8).bytes).toBe(32);
    const wide = makeAntic(0x2000, [0x4f, 0x00, 0x30, 0x41, 0x00, 0x10], 0x23);
    expect(wide.beginLine(8).bytes).toBe(48);
  });

  it('decodes the playfield width from DMACTL bits 0-1', () => {
    const antic = makeAntic(0x2000, []);
    antic.dmactl = 0x20;
    expect(antic.playfieldWidth).toBe(0);
    antic.dmactl = 0x21;
    expect(antic.playfieldWidth).toBe(256);
    antic.dmactl = 0x22;
    expect(antic.playfieldWidth).toBe(320);
    antic.dmactl = 0x23;
    expect(antic.playfieldWidth).toBe(384);
  });
});

describe('antic line sampling', () => {
  it('marks only the first scanline of a mode line as the one that fetches', () => {
    const antic = makeAntic(0x2000, [0x4d, 0x00, 0x30, 0x41, 0x00, 0x20]); // mode D: 2 scanlines
    const first = antic.beginLine(ANTIC_FIRST_LINE);
    expect(first.fetch).toBe(true);
    const second = antic.beginLine(ANTIC_FIRST_LINE + 1);
    expect(second.fetch).toBe(false);
    // And the blank line after (the JVB) fetches nothing.
    expect(antic.beginLine(ANTIC_FIRST_LINE + 2).fetch).toBe(false);
  });

  it('gives the line the width DMACTL has when it is sampled, not the one it began with', () => {
    // Mode 2 at DMACTL width 0 (playfield off) at the start of the line, then a
    // store, as after a WSYNC, turns on a normal width before the sample.
    const antic = makeAntic(0x2000, [0x42, 0x00, 0x30, 0x41, 0x00, 0x20], 0x20);
    const line = antic.beginLine(ANTIC_FIRST_LINE);
    expect(line.bytes).toBe(0);
    antic.dmactl = 0x22;
    antic.sampleFetch();
    expect(line.width).toBe(320);
    expect(line.bytes).toBe(40);
    expect(line.blank).toBe(false);
    expect(antic.stealCycles()).toBe(9 + 3 + 40 + 40); // refresh, DL bytes, names, glyphs
  });

  it('settles the scan counter on the bytes the sample fetched', () => {
    // Two one-scanline mode-F lines; the first begins narrow and is widened at the
    // sample, so the second must start 48 bytes on, not 32.
    const antic = makeAntic(0x2000, [0x4f, 0x00, 0x30, 0x0f, 0x41, 0x00, 0x20], 0x21);
    const first = antic.beginLine(ANTIC_FIRST_LINE);
    expect(first.bytes).toBe(32);
    antic.dmactl = 0x23;
    antic.sampleFetch();
    expect(first.bytes).toBe(48);
    const second = antic.beginLine(ANTIC_FIRST_LINE + 1);
    expect(second.screenAddr).toBe(0x3000 + 48);
  });

  it('lets a DMACTL store made after the sample wait for the next line', () => {
    const antic = makeAntic(0x2000, [0x4f, 0x00, 0x30, 0x0f, 0x41, 0x00, 0x20], 0x22);
    const first = antic.beginLine(ANTIC_FIRST_LINE);
    antic.sampleFetch();
    antic.dmactl = 0x21;               // a DLI handler's store, late
    expect(first.width).toBe(320);
    expect(first.bytes).toBe(40);
    const second = antic.beginLine(ANTIC_FIRST_LINE + 1);
    expect(second.bytes).toBe(32);
    expect(second.screenAddr).toBe(0x3000 + 40);
  });

  it('samples the player/missile DMA state as the line begins', () => {
    const antic = makeAntic(0x2000, [0x70, 0x41, 0x00, 0x20], 0x2e); // DL, players, missiles, double-line
    const line = antic.beginLine(ANTIC_FIRST_LINE);
    antic.dmactl = 0x20;               // stored later in the line
    expect(line.playerDma).toBe(true);
    expect(line.missileDma).toBe(true);
    expect(line.pmSingle).toBe(false);
  });
});

describe('antic status registers and reset', () => {
  it('reads PENV inverted-idle at $FF and PENH at 0 with no light pen', () => {
    const antic = new Antic();
    expect(antic.readReg(0x0c)).toBe(0x00);
    expect(antic.readReg(0x0d)).toBe(0xff);
  });

  it('ORs the reset bit into NMIST alongside a VBI without disturbing it', () => {
    const antic = new Antic();
    antic.postNmiStatus(true, false, true);
    expect(antic.nmist).toBe(0x60);
    antic.postNmiStatus(false, true);
    expect(antic.nmist).toBe(0xa0);   // DLI replaces VBI; RNMI stays
  });

  it('keeps the scroll, character and player registers, DLIST and NMIST through a warm reset', () => {
    const antic = new Antic();
    antic.hscrol = 5; antic.vscrol = 3; antic.pmbase = 0x40; antic.chbase = 0xe0; antic.chactl = 2;
    antic.dlist = 0x2000; antic.nmist = 0x40;
    antic.dmactl = 0x22; antic.nmien = 0xc0;
    antic.reset(true);
    expect(antic.dmactl).toBe(0);
    expect(antic.nmien).toBe(0);
    expect([antic.hscrol, antic.vscrol, antic.pmbase, antic.chbase, antic.chactl]).toEqual([5, 3, 0x40, 0xe0, 2]);
    expect(antic.dlist).toBe(0x2000);
    expect(antic.nmist).toBe(0x40);
    antic.reset();
    expect([antic.hscrol, antic.vscrol, antic.pmbase, antic.chbase, antic.chactl, antic.dlist, antic.nmist])
      .toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('shows VCOUNT moving to the next line from cycle 111, and wrapping one cycle later', () => {
    const antic = makeAntic(0x2000, graphics0List());
    antic.beginLine(21);
    expect(antic.vcountAt(0, 312)).toBe(10);
    expect(antic.vcountAt(110, 312)).toBe(10);
    expect(antic.vcountAt(111, 312)).toBe(11);   // line 22
    antic.beginLine(22);
    expect(antic.vcountAt(111, 312)).toBe(11);   // line 23 is still 11
    antic.beginLine(311);
    expect(antic.vcountAt(110, 312)).toBe(155);
    expect(antic.vcountAt(111, 312)).toBe(156);  // 312 / 2, one more cycle before 0
    expect(antic.vcountAt(112, 312)).toBe(0);
  });
});
