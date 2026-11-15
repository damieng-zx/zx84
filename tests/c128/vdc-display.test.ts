/**
 * What the 8563 VDC draws, worked out by hand from its register descriptions:
 * the RGBI palette, the character cell geometry, monochrome and attribute
 * colours, the alternate set, reverse, underline, flash, the cursor, the row
 * address increment, bitmap mode, the ninth pixel and the vertical scroll. The
 * frame is 704 × 248; the usual 80 × 25 cells of 8 × 8 sit at x 32, y 24.
 */

import { describe, it, expect } from 'vitest';
import { Vdc } from '@/machines/c128/vdc.ts';
import {
  renderVdc, VDC_FRAME_HEIGHT, VDC_FRAME_WIDTH, VDC_PALETTE,
} from '@/machines/c128/vdc-display.ts';
import { vdcScreenText } from '@/machines/c128/screen-text.ts';

const X0 = 32;                  // (704 - 80 × 8) / 2
const Y0 = 24;                  // (248 - 25 × 8) / 2

/** An ABGR frame word from its colour. */
const rgb = (r: number, g: number, b: number): number => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;

/** The editor's 80-column set-up, in mono (no attributes) unless a test turns them on. It is
 *  an early R7A chip (version 0), whose unscrolled R25 is 0: the scroll tests below that count in
 *  pixels from zero say so; the later chips have their own describe. */
function vdc(): Vdc {
  const v = new Vdc();
  v.version = 0;
  const regs: [number, number][] = [
    [1, 80], [6, 25], [9, 7], [22, 0x78], [23, 8], [24, 0x00], [25, 0x00],
    [26, 0xF1],                 // foreground 15 (white), background 1 (dark grey)
    [28, 0x20],                 // character set at $2000
    [20, 0x08],                 // attributes at $0800
    [29, 7],                    // underline on the last line
    [10, 0x20],                 // no cursor
  ];
  for (const [r, value] of regs) v.regs[r] = value;
  return v;
}

function frame(v: Vdc): Uint32Array {
  const out = new Uint32Array(VDC_FRAME_WIDTH * VDC_FRAME_HEIGHT);
  renderVdc(v, out);
  return out;
}
const at = (f: Uint32Array, x: number, y: number): number => f[y * VDC_FRAME_WIDTH + x];
const FG = VDC_PALETTE[15];
const BG = VDC_PALETTE[1];

/** Character `code`'s eight scan lines in the normal set. */
function glyph(v: Vdc, code: number, lines: number[], set = 0x2000): void {
  v.ram.set(lines, set + code * 16);
}

describe('VDC palette', () => {
  it('is RGBI: bit 3 red, bit 2 green, bit 1 blue, bit 0 intensity', () => {
    expect(VDC_PALETTE[0]).toBe(rgb(0, 0, 0));
    expect(VDC_PALETTE[1]).toBe(rgb(0x55, 0x55, 0x55));       // intensity alone: dark grey
    expect(VDC_PALETTE[2]).toBe(rgb(0, 0, 0xAA));             // dark blue
    expect(VDC_PALETTE[3]).toBe(rgb(0x55, 0x55, 0xFF));       // light blue
    expect(VDC_PALETTE[4]).toBe(rgb(0, 0xAA, 0));             // dark green
    expect(VDC_PALETTE[8]).toBe(rgb(0xAA, 0, 0));             // dark red
    expect(VDC_PALETTE[9]).toBe(rgb(0xFF, 0x55, 0x55));       // light red
    expect(VDC_PALETTE[14]).toBe(rgb(0xAA, 0xAA, 0xAA));      // light grey
    expect(VDC_PALETTE[15]).toBe(rgb(0xFF, 0xFF, 0xFF));      // white
  });
});

describe('VDC frame and border', () => {
  it('fills the border with the background colour (R26 low nibble)', () => {
    const f = frame(vdc());
    expect(at(f, 0, 0)).toBe(BG);
    expect(at(f, VDC_FRAME_WIDTH - 1, VDC_FRAME_HEIGHT - 1)).toBe(BG);
    expect(at(f, X0 - 1, Y0)).toBe(BG);
  });

  it('is all border while there are no columns or no rows', () => {
    const v = vdc();
    v.regs[1] = 0;
    v.ram[0x2000 + 16] = 0xFF;
    const f = frame(v);
    expect(f.every((p) => p === BG)).toBe(true);
  });

  it('draws the picture centred in the frame', () => {
    const v = vdc();
    v.regs[1] = 40;             // 320 wide: starts at (704 - 320) / 2 = 192
    v.regs[6] = 10;             // 80 lines: starts at (248 - 80) / 2 = 84
    glyph(v, 1, [0x80, 0, 0, 0, 0, 0, 0, 0]);
    v.ram[0] = 1;
    const f = frame(v);
    expect(at(f, 192, 84)).toBe(FG);
    expect(at(f, 191, 84)).toBe(BG);
    expect(at(f, 192, 83)).toBe(BG);
  });
});

describe('VDC text', () => {
  it('draws a character\'s 16-byte glyph from the set at R28 & $E0 << 8, high bit leftmost', () => {
    const v = vdc();
    glyph(v, 1, [0x80, 0x01, 0xFF, 0, 0, 0, 0, 0x81]);
    v.ram[0] = 1;
    const f = frame(v);
    expect(at(f, X0, Y0)).toBe(FG);
    expect(at(f, X0 + 1, Y0)).toBe(BG);
    expect(at(f, X0 + 7, Y0 + 1)).toBe(FG);
    expect(at(f, X0, Y0 + 1)).toBe(BG);
    for (let x = 0; x < 8; x++) expect(at(f, X0 + x, Y0 + 2), `x ${x}`).toBe(FG);
    expect(at(f, X0, Y0 + 7)).toBe(FG);
    expect(at(f, X0 + 7, Y0 + 7)).toBe(FG);
    expect(at(f, X0 + 3, Y0 + 7)).toBe(BG);
  });

  it('puts the next cell 8 pixels on, and the next row 8 lines down', () => {
    const v = vdc();
    glyph(v, 2, [0x80, 0, 0, 0, 0, 0, 0, 0]);
    v.ram[1] = 2;               // column 1, row 0
    v.ram[80] = 2;              // column 0, row 1
    const f = frame(v);
    expect(at(f, X0 + 8, Y0)).toBe(FG);
    expect(at(f, X0, Y0 + 8)).toBe(FG);
    expect(at(f, X0, Y0)).toBe(BG);
  });

  it('takes the screen from R12/R13', () => {
    const v = vdc();
    glyph(v, 3, [0x80, 0, 0, 0, 0, 0, 0, 0]);
    v.regs[12] = 0x01; v.regs[13] = 0x00;
    v.ram[0x0100] = 3;
    expect(at(frame(v), X0, Y0)).toBe(FG);
  });

  it('starts each row R1 + R27 bytes after the last', () => {
    const v = vdc();
    v.regs[27] = 2;
    glyph(v, 4, [0x80, 0, 0, 0, 0, 0, 0, 0]);
    v.ram[82] = 4;              // row 1 starts at 80 + 2
    const f = frame(v);
    expect(at(f, X0, Y0 + 8)).toBe(FG);
    v.ram[82] = 0; v.ram[80] = 4;
    expect(at(frame(v), X0, Y0 + 8), 'the padding bytes are not shown').toBe(BG);
  });

  it('shows only R23 + 1 lines of a taller cell, and takes the cell height from R9', () => {
    const v = vdc();
    v.regs[9] = 15;             // 16 lines to a row
    v.regs[23] = 3;             // of which 4 are shown (R23 + 1)
    v.regs[6] = 12;             // 192 lines
    glyph(v, 5, [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0, 0]);
    v.ram[0] = 5;
    v.ram[80] = 5;
    const f = frame(v);
    const y0 = (VDC_FRAME_HEIGHT - 192) >> 1;
    expect(at(f, X0, y0 + 3)).toBe(FG);
    expect(at(f, X0, y0 + 4), 'line 4 is not shown').toBe(BG);
    expect(at(f, X0, y0 + 16), 'row 1 starts 16 lines down').toBe(FG);
  });
});

describe('VDC attributes', () => {
  function coloured(): Vdc {
    const v = vdc();
    v.regs[25] = 0x40;          // attributes on
    glyph(v, 1, [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
    v.ram[0] = 1;
    return v;
  }

  it('takes the foreground colour from the attribute byte\'s low nibble when attributes are on', () => {
    const v = coloured();
    v.ram[0x0800] = 0x05;       // light green
    expect(at(frame(v), X0, Y0)).toBe(VDC_PALETTE[5]);
  });

  it('takes the foreground from R26\'s high nibble when they are off, and ignores the attribute RAM', () => {
    const v = coloured();
    v.regs[25] = 0x00;
    v.ram[0x0800] = 0x05;
    expect(at(frame(v), X0, Y0)).toBe(FG);
  });

  it('swaps foreground and background for the reverse attribute (bit 6)', () => {
    const v = coloured();
    v.ram[0x0800] = 0x4A;
    const f = frame(v);
    expect(at(f, X0, Y0), 'the lit pixel takes the background').toBe(BG);
    expect(at(f, X0 + 1, Y0), 'the rest takes the foreground').toBe(VDC_PALETTE[0x0A]);
  });

  it('reverses every cell when R24 bit 6 is set', () => {
    const v = vdc();
    v.regs[24] = 0x40;
    const f = frame(v);
    expect(at(f, X0 + 20, Y0 + 20), 'an empty cell shows the foreground').toBe(FG);
    expect(at(f, 0, 0), 'the border is not reversed').toBe(BG);
  });

  it('reads the character from the set 4K further on for the alternate set attribute (bit 7)', () => {
    const v = coloured();
    glyph(v, 1, [0x01, 0, 0, 0, 0, 0, 0, 0], 0x3000);
    v.ram[0x0800] = 0x8F;
    const f = frame(v);
    expect(at(f, X0 + 7, Y0)).toBe(VDC_PALETTE[15]);
    expect(at(f, X0, Y0), 'not the normal set\'s glyph').toBe(BG);
  });

  it('draws the underline attribute (bit 5) across the whole cell on the line in R29', () => {
    const v = coloured();
    v.ram[0x0800] = 0x2F;
    v.regs[29] = 6;
    const f = frame(v);
    for (let x = 0; x < 8; x++) expect(at(f, X0 + x, Y0 + 6), `x ${x}`).toBe(FG);
    expect(at(f, X0 + 4, Y0 + 5)).toBe(BG);
    expect(at(f, X0 + 4, Y0 + 7)).toBe(BG);
  });

  it('flashes (bit 4) by alternating with reverse, 8 frames of each at the 1/16 rate', () => {
    const v = coloured();
    v.ram[0x0800] = 0x1F;
    v.frame = 0;
    expect(at(frame(v), X0, Y0), 'frame 0 normal').toBe(FG);
    v.frame = 7;
    expect(at(frame(v), X0, Y0), 'frame 7 normal').toBe(FG);
    v.frame = 8;
    expect(at(frame(v), X0, Y0), 'frame 8 reversed').toBe(BG);
    v.frame = 15;
    expect(at(frame(v), X0, Y0), 'frame 15 reversed').toBe(BG);
    v.frame = 16;
    expect(at(frame(v), X0, Y0), 'frame 16 normal again').toBe(FG);
  });

  it('flashes at the 1/30 rate when R24 bit 5 is set: 15 frames of each', () => {
    const v = coloured();
    v.ram[0x0800] = 0x1F;
    v.regs[24] = 0x20;
    v.frame = 14;
    expect(at(frame(v), X0, Y0)).toBe(FG);
    v.frame = 15;
    expect(at(frame(v), X0, Y0)).toBe(BG);
    v.frame = 29;
    expect(at(frame(v), X0, Y0)).toBe(BG);
    v.frame = 30;
    expect(at(frame(v), X0, Y0)).toBe(FG);
  });
});

describe('VDC cursor', () => {
  function withCursor(mode: number): Vdc {
    const v = vdc();
    glyph(v, 1, [0x80, 0, 0, 0, 0, 0, 0, 0]);
    v.ram[0] = 1;
    v.regs[10] = mode;          // bits 6-5 the mode, 4-0 the first line
    v.regs[11] = 3;             // the last line
    v.regs[14] = 0; v.regs[15] = 0;
    return v;
  }

  it('inverts the cell on the lines R10 & 31 to R11 & 31 when steady (mode 0)', () => {
    const v = withCursor(0x01);                    // lines 1 to 3
    const f = frame(v);
    expect(at(f, X0, Y0), 'line 0 is the character').toBe(FG);
    expect(at(f, X0 + 1, Y0)).toBe(BG);
    expect(at(f, X0, Y0 + 1), 'inverted: the empty line is lit').toBe(FG);
    expect(at(f, X0 + 7, Y0 + 3)).toBe(FG);
    expect(at(f, X0, Y0 + 4), 'past the last cursor line').toBe(BG);
  });

  it('is not drawn in mode 1', () => {
    const f = frame(withCursor(0x20));
    expect(at(f, X0 + 1, Y0 + 1)).toBe(BG);
  });

  it('is drawn at the cursor position, a cell index from the start of the screen', () => {
    const v = withCursor(0x00);
    v.regs[14] = 0; v.regs[15] = 81;               // row 1, column 1
    const f = frame(v);
    expect(at(f, X0 + 8, Y0 + 8)).toBe(FG);
    expect(at(f, X0, Y0 + 1), 'not at cell 0 any more').toBe(BG);
  });

  it('blinks at 1/16 in mode 2: shown for 8 frames, hidden for 8', () => {
    const v = withCursor(0x40);
    v.frame = 7;
    expect(at(frame(v), X0 + 1, Y0 + 1)).toBe(FG);
    v.frame = 8;
    expect(at(frame(v), X0 + 1, Y0 + 1)).toBe(BG);
    v.frame = 16;
    expect(at(frame(v), X0 + 1, Y0 + 1)).toBe(FG);
  });

  it('blinks at 1/32 in mode 3: shown for 16 frames, hidden for 16', () => {
    const v = withCursor(0x60);
    v.frame = 15;
    expect(at(frame(v), X0 + 1, Y0 + 1)).toBe(FG);
    v.frame = 16;
    expect(at(frame(v), X0 + 1, Y0 + 1)).toBe(BG);
    v.frame = 32;
    expect(at(frame(v), X0 + 1, Y0 + 1)).toBe(FG);
  });
});

describe('VDC bitmap mode', () => {
  it('shows the display RAM as the picture: a byte is eight pixels, a row of one line is R1 bytes', () => {
    const v = vdc();
    v.regs[25] = 0x80;
    v.regs[9] = 0;              // one line to a row
    v.regs[23] = 1;
    v.regs[6] = 200;            // 200 rows of one line
    v.ram[0] = 0xA5;            // 1010 0101
    v.ram[80] = 0xFF;           // the second line
    const f = frame(v);
    const bits = [1, 0, 1, 0, 0, 1, 0, 1];
    for (let x = 0; x < 8; x++) expect(at(f, X0 + x, Y0), `x ${x}`).toBe(bits[x] ? FG : BG);
    for (let x = 0; x < 8; x++) expect(at(f, X0 + x, Y0 + 1), `line 1 x ${x}`).toBe(FG);
  });
});

describe('VDC cell width', () => {
  it('draws pixels past the eighth as background, or as the eighth repeated in semigraphic mode', () => {
    const v = vdc();
    v.regs[1] = 40;
    v.regs[22] = 0x89;          // 9 pixels to a cell, all shown
    glyph(v, 1, [0x01, 0, 0, 0, 0, 0, 0, 0]);
    v.ram[0] = 1;
    const x0 = (VDC_FRAME_WIDTH - 40 * 9) >> 1;
    let f = frame(v);
    expect(at(f, x0 + 7, Y0)).toBe(FG);
    expect(at(f, x0 + 8, Y0), 'the ninth pixel is background').toBe(BG);
    v.regs[25] = 0x20;
    f = frame(v);
    expect(at(f, x0 + 8, Y0), 'the ninth pixel repeats the eighth').toBe(FG);
  });

  it('puts the cells R22 >> 4 + 1 pixels apart and shows the pixels the low nibble says: one more than it where it is the smaller', () => {
    const v = vdc();
    v.regs[1] = 40;
    v.regs[22] = 0x65;          // 7 pixels apart, 6 shown
    glyph(v, 1, [0xFF, 0, 0, 0, 0, 0, 0, 0]);
    v.ram[0] = 1; v.ram[1] = 1;
    const x0 = (VDC_FRAME_WIDTH - 40 * 7) >> 1;
    const f = frame(v);
    expect(at(f, x0 + 5, Y0)).toBe(FG);
    expect(at(f, x0 + 6, Y0), 'the seventh pixel is the gap').toBe(BG);
    expect(at(f, x0 + 7, Y0), 'the next cell starts 7 on').toBe(FG);
  });
});

describe('VDC scrolling', () => {
  it('moves the picture up by the vertical scroll (R24 bits 4-0) lines', () => {
    const v = vdc();
    glyph(v, 1, [0, 0, 0, 0x80, 0, 0, 0, 0]);
    v.ram[0] = 1;
    v.regs[24] = 3;
    const f = frame(v);
    expect(at(f, X0, Y0), 'the cell\'s line 3 is now the top line').toBe(FG);
    expect(at(f, X0, Y0 + 1)).toBe(BG);
  });

  it('moves the picture right by the horizontal scroll (R25 bits 3-0) pixels on an R7A', () => {
    const v = vdc();
    glyph(v, 1, [0x80, 0, 0, 0, 0, 0, 0, 0]);
    v.ram[0] = 1;
    v.regs[25] = 0x02;
    const f = frame(v);
    expect(at(f, X0 + 2, Y0)).toBe(FG);
    expect(at(f, X0, Y0)).toBe(BG);
  });
});

describe('VDC frame limits', () => {
  it('draws a display larger than the frame without writing outside it', () => {
    const v = vdc();
    v.regs[1] = 255;
    v.regs[6] = 100;
    v.regs[22] = 0xF8;
    v.ram.fill(0xFF, 0, 0x2000);
    expect(() => frame(v)).not.toThrow();
  });
});

describe('VDC screen as text', () => {
  /** A screen the editor has cleared: spaces (screen code 32) everywhere. */
  function cleared(): Vdc {
    const v = vdc();
    v.ram.fill(32, 0, 0x0800);
    return v;
  }

  it('reads the screen codes as the 64\'s: 8 and 9 are H and I', () => {
    const v = cleared();
    v.ram[0] = 8; v.ram[1] = 9;
    v.ram[80 + 2] = 1;          // A, on the second row
    expect(vdcScreenText(v)).toBe('HI\n  A');
  });

  it('reads the lower-case set for cells with the alternate-set attribute', () => {
    const v = cleared();
    v.regs[25] = 0x40;
    v.ram[0] = 8; v.ram[1] = 9;
    v.ram[0x0800] = 0x80; v.ram[0x0801] = 0x80;
    expect(vdcScreenText(v)).toBe('hi');
  });

  it('follows the screen start and the row increment', () => {
    const v = cleared();
    v.regs[12] = 0x01;
    v.regs[27] = 4;
    v.ram.fill(32, 0x0100, 0x0100 + 84 * 25);
    v.ram[0x0100] = 8;
    v.ram[0x0100 + 84] = 9;
    expect(vdcScreenText(v)).toBe('H\nI');
  });

  it('says so for a bitmap screen', () => {
    const v = cleared();
    v.regs[25] = 0x80;
    expect(vdcScreenText(v)).toMatch(/bitmap/);
  });

  it('is empty for a blank screen', () => {
    expect(vdcScreenText(cleared())).toBe('');
  });
});
