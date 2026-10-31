import { describe, it, expect } from 'vitest';
import {
  renderNewBrainFrame, newBrainScreenRows, TVCTL_RV, TVCTL_80,
} from '@/machines/newbrain/newbrain-video.ts';
import { NB_INK, NB_PAPER, NB_SCREEN_WIDTH, NB_ACTIVE_LINES } from '@/machines/newbrain/constants.ts';

/** A character ROM with one glyph: 'A' (0x41) has only the leftmost dot of its
 *  first row lit (row byte 0x80, bit 0 clear so the descender rule leaves it
 *  alone). Every other character is blank. */
function chars(): Uint8Array {
  const c = new Uint8Array(0x1000);
  c[(0 << 8) | 0x41] = 0x80;
  return c;
}

/** 32K of spaces, so no run of zero bytes ends the text. */
function spaces(): Uint8Array { return new Uint8Array(0x8000).fill(0x20); }

function frame(ram: Uint8Array, tvl: number, tvctl: number): Uint32Array {
  const out = new Uint32Array(NB_SCREEN_WIDTH * NB_ACTIVE_LINES);
  renderNewBrainFrame(out, ram, tvl, tvctl, chars());
  return out;
}

const px = (f: Uint32Array, x: number, y: number) => f[y * NB_SCREEN_WIDTH + x];

describe('NewBrain video — text', () => {
  it('starts a row at the third byte of a 64-byte row and doubles every dot in 40 columns', () => {
    const ram = spaces();
    ram[2] = 0x41;                           // first character of the first row
    const f = frame(ram, 0, 0);
    expect(px(f, 0, 0)).toBe(NB_INK);
    expect(px(f, 1, 0)).toBe(NB_INK);        // 40 columns: each dot is two wide
    expect(px(f, 2, 0)).toBe(NB_PAPER);
    expect(px(f, 0, 1)).toBe(NB_PAPER);      // the glyph's second row is empty
    expect(px(f, 16, 0)).toBe(NB_PAPER);     // the next cell is a space
  });

  it('puts the second character row ten scan lines down, 64 bytes on', () => {
    const ram = spaces();
    ram[2 + 64] = 0x41;
    const f = frame(ram, 0, 0);
    expect(px(f, 0, 10)).toBe(NB_INK);
    expect(px(f, 0, 9)).toBe(NB_PAPER);
    expect(px(f, 0, 0)).toBe(NB_PAPER);
  });

  it('starts at the fifth byte of a 128-byte row and draws single dots in 80 columns', () => {
    const ram = spaces();
    ram[4] = 0x41;
    ram[4 + 1] = 0x41;                       // the second cell
    const f = frame(ram, 0, TVCTL_80);
    expect(px(f, 0, 0)).toBe(NB_INK);
    expect(px(f, 1, 0)).toBe(NB_PAPER);      // not doubled
    expect(px(f, 8, 0)).toBe(NB_INK);        // second cell, 8 dots on
  });

  it('shows the start address from A6-A14 of the TVL register', () => {
    const ram = spaces();
    ram[0x1000 + 2] = 0x41;
    const f = frame(ram, 0x1000, 0);
    expect(px(f, 0, 0)).toBe(NB_INK);
  });

  it('inverts every dot, blank cells included, with reverse video', () => {
    const ram = spaces();
    ram[2] = 0x41;
    const f = frame(ram, 0, TVCTL_RV);
    expect(px(f, 0, 0)).toBe(NB_PAPER);
    expect(px(f, 2, 0)).toBe(NB_INK);
    expect(px(f, 100, 100)).toBe(NB_INK);
  });
});

describe('NewBrain video — graphics', () => {
  it('turns the rest of the picture into raw bytes, least significant bit first, after three zero bytes', () => {
    const ram = spaces();
    // Three zeros in a row take the third flip-flop low: from the fourth cell
    // on, bytes are bit patterns, 8 dots a cell (16 wide in 40 columns).
    ram[2] = ram[3] = ram[4] = 0;
    ram[5] = 0x01;                           // cell 3, dot 0
    const f = frame(ram, 0, 0);
    const x = 3 * 16;
    expect(px(f, x, 0)).toBe(NB_INK);
    expect(px(f, x + 1, 0)).toBe(NB_INK);
    expect(px(f, x + 2, 0)).toBe(NB_PAPER);
    // The next scan line carries on with the next byte: 40 cells = 40 bytes on.
    ram[2 + 40] = 0x80;                      // the first byte of line 1, dot 7
    const g = frame(ram, 0, 0);
    expect(px(g, 7 * 2, 1)).toBe(NB_INK);
    expect(px(g, 6 * 2, 1)).toBe(NB_PAPER);
  });
});

describe('NewBrain screen text', () => {
  it('reads rows out of RAM and stops at the first run of zero bytes', () => {
    const ram = spaces();
    const put = (row: number, text: string) => {
      for (let i = 0; i < text.length; i++) ram[2 + row * 64 + i] = text.charCodeAt(i);
    };
    put(0, 'NEWBRAIN BASIC');
    put(1, 'READY');
    ram.fill(0, 2 + 2 * 64, 2 + 2 * 64 + 4);
    expect(newBrainScreenRows(ram, 0, 0)).toEqual(['NEWBRAIN BASIC', 'READY']);
  });
});
