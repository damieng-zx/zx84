/**
 * SamAsic — the four screen modes, the CLUT, and mid-line writes.
 *
 * Every address and pixel expectation below is hand-computed from the SAM's
 * documented screen layouts, never read back out of the implementation:
 *
 *   Mode 1  256x192  6144 bitmap (Spectrum third/char-row/pixel-row interleave)
 *                    + 768 attributes at +6144, one per 8x8 cell
 *   Mode 2  256x192  6144 bitmap, LINEAR (y*32 + col)
 *                    + 6144 attributes at +0x2000, one per cell PER SCANLINE
 *   Mode 3  512x192  2 bits/pixel, 128 bytes/line, MSB pair leftmost, CLUT 0-3
 *   Mode 4  256x192  4 bits/pixel, 128 bytes/line, high nibble leftmost
 *
 * The frame buffer is 768 px wide and sampled at mode 3's resolution, so one
 * character cell is always 16 buffer pixels: modes 1/2/4 double each logical
 * pixel, mode 3 is 1:1.
 */

import { describe, expect, it } from 'vitest';
import { SamAsic } from '@/machines/sam/asic.ts';
import { SamMemory } from '@/machines/sam/sam-memory.ts';
import { createSamConfig } from '@/machines/sam/config.ts';
import {
  SAM_ASIC_CELL_OFFSET, SAM_BORDER_LEFT, SAM_BORDER_TOP, SAM_CELL_PX,
  SAM_DISPLAY_LAST_LINE,
  SAM_PALETTE, SAM_SCREEN_HEIGHT, SAM_SCREEN_WIDTH, SAM_T_PER_CELL,
} from '@/machines/sam/constants.ts';

/** Screen line 0 sits at buffer row SAM_BORDER_TOP. */
const rasterOf = (y: number) => SAM_BORDER_TOP + y;

interface Rig {
  asic: SamAsic;
  memory: SamMemory;
  px: Uint32Array;
  /** Write one byte of display memory at `offset` within the 24K window. */
  vram(offset: number, value: number): void;
  /** Latch state and draw one screen line; returns the buffer row. */
  draw(y: number): Uint32Array;
  /** Buffer pixel `x` of the active area on the last drawn row. */
  at(row: Uint32Array, x: number): number;
}

function rig(mode: 1 | 2 | 3 | 4, page = 0): Rig {
  const memory = new SamMemory(createSamConfig('sam512'));
  // VMPR: mode is (bits 5-6) + 1, page in bits 0-4.
  memory.setVmpr(((mode - 1) << 5) | page);
  const asic = new SamAsic(memory);
  const px = new Uint32Array(SAM_SCREEN_WIDTH * SAM_SCREEN_HEIGHT);

  const base = memory.videoBasePage;
  const vram = (offset: number, value: number) => {
    const pg = memory.videoPage(base + (offset >= 0x4000 ? 1 : 0));
    pg[offset & 0x3FFF] = value;
  };

  const draw = (y: number) => {
    const line = rasterOf(y);
    asic.beginLine(line, 0);
    asic.renderScanline(px, line);
    return px.subarray(line * SAM_SCREEN_WIDTH, (line + 1) * SAM_SCREEN_WIDTH);
  };

  return {
    asic, memory, px, vram, draw,
    at: (row, x) => row[SAM_BORDER_LEFT + x],
  };
}

/** Give the CLUT distinct, identifiable palette codes: entry i -> code i. */
function markClut(asic: SamAsic): void {
  for (let i = 0; i < 16; i++) asic.clut[i] = i;
}

/** The packed colour the CLUT entry `i` resolves to under markClut. */
const colour = (i: number) => SAM_PALETTE[i];

describe('SamAsic mode 1 (Spectrum layout)', () => {
  it('fetches the bitmap through the Spectrum third/row interleave', () => {
    // Screen line 1 lives at 0x0100, not 0x0020: the low three bits of y are
    // the pixel row within a character and occupy bits 8-10 of the address.
    //   bmp = ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | col
    const r = rig(1);
    markClut(r.asic);
    r.vram(0x0100, 0x80);          // line 1, col 0, leftmost pixel set
    r.vram(6144 + 0, 0x01);        // attr row 0 col 0: ink 1, paper 0

    const row = r.draw(1);
    // One logical pixel spans two buffer pixels.
    expect(r.at(row, 0)).toBe(colour(1));
    expect(r.at(row, 1)).toBe(colour(1));
    expect(r.at(row, 2)).toBe(colour(0));
  });

  it('places the third boundary at screen line 64', () => {
    // y = 64 sets bit 6, so (y & 0xC0) << 5 = 0x0800.
    const r = rig(1);
    markClut(r.asic);
    r.vram(0x0800, 0xFF);
    r.vram(6144 + (64 >> 3) * 32, 0x02);   // ink 2

    const row = r.draw(64);
    expect(r.at(row, 0)).toBe(colour(2));
  });

  it('reads one attribute per 8x8 cell, shared down the character row', () => {
    const r = rig(1);
    markClut(r.asic);
    r.vram(6144 + 0, 0x03);        // ink 3 for cell row 0
    for (let y = 0; y < 8; y++) {
      r.vram(((y & 7) << 8), 0x80);
      expect(r.at(r.draw(y), 0)).toBe(colour(3));
    }
  });

  it('takes the CLUT index bit 3 from the attribute BRIGHT bit', () => {
    // ink index = (attr & 7) | ((attr & 0x40) >> 3), so BRIGHT reaches the
    // upper half of the CLUT — 16 colours on screen, via the SAM's palette.
    const r = rig(1);
    markClut(r.asic);
    r.vram(0x0000, 0x80);
    r.vram(6144, 0x41);            // BRIGHT | ink 1  -> CLUT 9
    expect(r.at(r.draw(0), 0)).toBe(colour(9));
  });

  it('decodes paper from attribute bits 3-5', () => {
    const r = rig(1);
    markClut(r.asic);
    r.vram(0x0000, 0x00);          // all pixels clear -> all paper
    r.vram(6144, 0x28);            // paper 5, ink 0
    expect(r.at(r.draw(0), 0)).toBe(colour(5));
  });
});

describe('SamAsic mode 2 (linear bitmap, per-scanline attributes)', () => {
  it('fetches the bitmap linearly, unlike mode 1', () => {
    // The mode-1 vs mode-2 address boundary is the interesting case: screen
    // line 1 is at +32 here, where mode 1 puts it at +0x0100.
    const r = rig(2);
    markClut(r.asic);
    r.vram(32, 0x80);              // line 1, col 0
    r.vram(0x2000 + 32, 0x04);     // its attribute: ink 4
    expect(r.at(r.draw(1), 0)).toBe(colour(4));

    // Nothing should be read from the mode-1 address for that line.
    const r2 = rig(2);
    markClut(r2.asic);
    r2.vram(0x0100, 0xFF);
    r2.vram(0x2000 + 32, 0x04);
    expect(r2.at(r2.draw(1), 0)).toBe(colour(0));
  });

  it('gives every scanline its own attribute row', () => {
    // 6144 attribute bytes / 32 per line = 192 rows, one per scanline — the
    // whole point of mode 2 over mode 1.
    const r = rig(2);
    markClut(r.asic);
    for (let y = 0; y < 8; y++) {
      r.vram(y * 32, 0x80);
      r.vram(0x2000 + y * 32, y & 0x07);   // a different ink on each line
    }
    for (let y = 1; y < 8; y++) {
      expect(r.at(r.draw(y), 0)).toBe(colour(y));
    }
  });
});

describe('SamAsic mode 3 (512x192, 2bpp)', () => {
  it('unpacks four pixels per byte, most-significant pair first', () => {
    // 0xE4 = 11 10 01 00 -> CLUT 3, 2, 1, 0 across four adjacent pixels.
    const r = rig(3);
    markClut(r.asic);
    r.vram(0, 0xE4);
    const row = r.draw(0);
    expect(r.at(row, 0)).toBe(colour(3));
    expect(r.at(row, 1)).toBe(colour(2));
    expect(r.at(row, 2)).toBe(colour(1));
    expect(r.at(row, 3)).toBe(colour(0));
  });

  it('is 1:1 with the buffer — no pixel doubling', () => {
    const r = rig(3);
    markClut(r.asic);
    r.vram(0, 0xC0);               // 11 00 00 00 -> only pixel 0 is CLUT 3
    const row = r.draw(0);
    expect(r.at(row, 0)).toBe(colour(3));
    expect(r.at(row, 1)).toBe(colour(0));
  });

  it('uses 128 bytes per line', () => {
    const r = rig(3);
    markClut(r.asic);
    r.vram(128, 0xC0);             // start of screen line 1
    expect(r.at(r.draw(1), 0)).toBe(colour(3));
    expect(r.at(r.draw(0), 0)).toBe(colour(0));
  });

  it('spans the 24K page pair, reaching into the second page', () => {
    // Screen line 130 starts at 130*128 = 16640, i.e. 256 bytes into page 2.
    const r = rig(3);
    markClut(r.asic);
    r.vram(130 * 128, 0xC0);
    expect(r.at(r.draw(130), 0)).toBe(colour(3));
  });
});

describe('SamAsic mode 4 (256x192, 4bpp)', () => {
  it('unpacks two pixels per byte, high nibble leftmost', () => {
    // 0x5A -> CLUT 5 then CLUT 10, each two buffer pixels wide.
    const r = rig(4);
    markClut(r.asic);
    r.vram(0, 0x5A);
    const row = r.draw(0);
    expect(r.at(row, 0)).toBe(colour(5));
    expect(r.at(row, 1)).toBe(colour(5));
    expect(r.at(row, 2)).toBe(colour(10));
    expect(r.at(row, 3)).toBe(colour(10));
  });

  it('reaches every CLUT entry', () => {
    const r = rig(4);
    markClut(r.asic);
    for (let i = 0; i < 8; i++) r.vram(i, (i * 2) << 4 | (i * 2 + 1));
    const row = r.draw(0);
    for (let i = 0; i < 8; i++) {
      expect(r.at(row, i * 4)).toBe(colour(i * 2));
      expect(r.at(row, i * 4 + 2)).toBe(colour(i * 2 + 1));
    }
  });

  it('uses 128 bytes per line, like mode 3', () => {
    const r = rig(4);
    markClut(r.asic);
    r.vram(128, 0xF0);
    expect(r.at(r.draw(1), 0)).toBe(colour(15));
    expect(r.at(r.draw(0), 0)).toBe(colour(0));
  });
});

describe('SamAsic display page selection', () => {
  it('ignores VMPR page bit 0 in modes 3 and 4, which need a 24K pair', () => {
    // VMPR page 5 in mode 4 means the pair 4/5, so the data must be written to
    // page 4 to appear at screen offset 0.
    const memory = new SamMemory(createSamConfig('sam512'));
    memory.setVmpr(0x60 | 5);
    expect(memory.videoBasePage).toBe(4);

    const asic = new SamAsic(memory);
    for (let i = 0; i < 16; i++) asic.clut[i] = i;
    memory.videoPage(4)[0] = 0xF0;

    const px = new Uint32Array(SAM_SCREEN_WIDTH * SAM_SCREEN_HEIGHT);
    const line = rasterOf(0);
    asic.beginLine(line, 0);
    asic.renderScanline(px, line);
    expect(px[line * SAM_SCREEN_WIDTH + SAM_BORDER_LEFT]).toBe(colour(15));
  });

  it('honours the page bit in modes 1 and 2', () => {
    const memory = new SamMemory(createSamConfig('sam512'));
    memory.setVmpr(0x00 | 5);
    expect(memory.videoBasePage).toBe(5);
  });
});

describe('SamAsic border and blanking', () => {
  it('surrounds the active area with the border colour', () => {
    const r = rig(4);
    markClut(r.asic);
    r.asic.borderIndex = 7;
    const row = r.draw(0);
    // Just left of the active window, and just right of it.
    expect(row[SAM_BORDER_LEFT - 1]).toBe(colour(7));
    expect(row[SAM_BORDER_LEFT + 512]).toBe(colour(7));
  });

  it('fills whole lines above and below the display with border', () => {
    const r = rig(4);
    markClut(r.asic);
    r.asic.borderIndex = 6;

    for (const line of [0, SAM_BORDER_TOP - 1, SAM_DISPLAY_LAST_LINE, SAM_SCREEN_HEIGHT - 1]) {
      r.asic.beginLine(line, 0);
      r.asic.renderScanline(r.px, line);
      const row = r.px.subarray(line * SAM_SCREEN_WIDTH, (line + 1) * SAM_SCREEN_WIDTH);
      expect(row[SAM_BORDER_LEFT]).toBe(colour(6));
      expect(row[0]).toBe(colour(6));
    }
  });

  it('blanks the display to the border when SOFF is set', () => {
    const r = rig(4);
    markClut(r.asic);
    r.vram(0, 0xFF);
    r.asic.borderIndex = 2;
    expect(r.at(r.draw(0), 0)).toBe(colour(15));

    r.asic.screenOff = true;
    expect(r.at(r.draw(0), 0)).toBe(colour(2));
  });

  it('never writes outside the frame buffer', () => {
    const r = rig(4);
    r.asic.beginLine(SAM_SCREEN_HEIGHT, 0);
    r.asic.renderScanline(r.px, SAM_SCREEN_HEIGHT);      // vertical blanking
    r.asic.renderScanline(r.px, -1);
    // Nothing drawn: the buffer is still entirely zero.
    expect(r.px.every(v => v === 0)).toBe(true);
  });
});

describe('SamAsic mid-line palette and border writes', () => {
  it('changes colour from the cell the write landed on, not the whole line', () => {
    // A CLUT write that lands on raster cell 20 must leave cells 0-19 alone.
    const r = rig(4);
    markClut(r.asic);
    for (let i = 0; i < 128; i++) r.vram(i, 0x00);   // whole line is CLUT 0

    const line = rasterOf(0);
    r.asic.beginLine(line, 0);
    // The beam lags the CPU's line boundary by SAM_ASIC_CELL_OFFSET cells, so
    // a write at CPU cell 28 is drawn at raster cell 20 — 12 cells into the
    // display window, which occupies raster cells 8-39.
    r.asic.writeClut(0, 0x7F, (20 + SAM_ASIC_CELL_OFFSET) * SAM_T_PER_CELL);
    r.asic.renderScanline(r.px, line);
    const row = r.px.subarray(line * SAM_SCREEN_WIDTH, (line + 1) * SAM_SCREEN_WIDTH);

    // Cell 19 still shows the original colour, cell 20 onwards the new one.
    expect(row[19 * SAM_CELL_PX]).toBe(colour(0));
    expect(row[20 * SAM_CELL_PX]).toBe(SAM_PALETTE[0x7F]);
    expect(row[21 * SAM_CELL_PX]).toBe(SAM_PALETTE[0x7F]);
  });

  it('splits the border mid-line too', () => {
    const r = rig(4);
    markClut(r.asic);
    r.asic.borderIndex = 1;

    const line = rasterOf(0);
    r.asic.beginLine(line, 0);
    r.asic.writeBorder(9, false, (4 + SAM_ASIC_CELL_OFFSET) * SAM_T_PER_CELL);
    r.asic.renderScanline(r.px, line);
    const row = r.px.subarray(line * SAM_SCREEN_WIDTH, (line + 1) * SAM_SCREEN_WIDTH);

    expect(row[3 * SAM_CELL_PX]).toBe(colour(1));
    expect(row[4 * SAM_CELL_PX]).toBe(colour(9));
  });

  it('resolves a write at the very start of the line to cell 0', () => {
    const r = rig(4);
    markClut(r.asic);
    r.asic.borderIndex = 1;
    const line = rasterOf(0);
    r.asic.beginLine(line, 0);
    r.asic.writeBorder(12, false, 0);
    r.asic.renderScanline(r.px, line);
    expect(r.px[line * SAM_SCREEN_WIDTH]).toBe(colour(12));
  });

  it('draws the beam one side border behind the CPU line boundary', () => {
    // The whole point of SAM_ASIC_CELL_OFFSET: a write in the CPU line's first
    // eight cells belongs to the tail of the raster line already drawn, so it
    // colours this one from its very first cell; only past that does the split
    // move right, one raster cell per CPU cell.
    const r = rig(4);
    markClut(r.asic);
    r.asic.borderIndex = 1;
    const line = rasterOf(0);

    r.asic.beginLine(line, 0);
    r.asic.writeBorder(12, false, SAM_ASIC_CELL_OFFSET * SAM_T_PER_CELL);
    r.asic.renderScanline(r.px, line);
    expect(r.px[line * SAM_SCREEN_WIDTH]).toBe(colour(12));

    r.asic.borderIndex = 1;
    r.asic.beginLine(line, 0);
    r.asic.writeBorder(12, false, (SAM_ASIC_CELL_OFFSET + 3) * SAM_T_PER_CELL);
    r.asic.renderScanline(r.px, line);
    const row = r.px.subarray(line * SAM_SCREEN_WIDTH, (line + 1) * SAM_SCREEN_WIDTH);
    expect(row[2 * SAM_CELL_PX]).toBe(colour(1));
    expect(row[3 * SAM_CELL_PX]).toBe(colour(12));
  });

  it('clamps a write beyond the end of the line into the last cell', () => {
    const r = rig(4);
    markClut(r.asic);
    r.asic.borderIndex = 1;
    const line = rasterOf(0);
    r.asic.beginLine(line, 0);
    r.asic.writeBorder(12, false, 9999);
    r.asic.renderScanline(r.px, line);
    const row = r.px.subarray(line * SAM_SCREEN_WIDTH, (line + 1) * SAM_SCREEN_WIDTH);
    expect(row[SAM_SCREEN_WIDTH - 1]).toBe(colour(12));
    expect(row[0]).toBe(colour(1));
  });

  it('applies several writes on one line in order', () => {
    const r = rig(4);
    markClut(r.asic);
    r.asic.borderIndex = 0;
    const line = rasterOf(0);
    r.asic.beginLine(line, 0);
    r.asic.writeBorder(1, false, (2 + SAM_ASIC_CELL_OFFSET) * SAM_T_PER_CELL);
    r.asic.writeBorder(2, false, (4 + SAM_ASIC_CELL_OFFSET) * SAM_T_PER_CELL);
    r.asic.writeBorder(3, false, (6 + SAM_ASIC_CELL_OFFSET) * SAM_T_PER_CELL);
    r.asic.renderScanline(r.px, line);
    const row = r.px.subarray(line * SAM_SCREEN_WIDTH, (line + 1) * SAM_SCREEN_WIDTH);
    expect(row[1 * SAM_CELL_PX]).toBe(colour(0));
    expect(row[3 * SAM_CELL_PX]).toBe(colour(1));
    expect(row[5 * SAM_CELL_PX]).toBe(colour(2));
    expect(row[7 * SAM_CELL_PX]).toBe(colour(3));
  });

  it('survives a flood of writes on one line without unbounded growth', () => {
    // The journal is a fixed ring; excess writes are dropped, not accumulated.
    const r = rig(4);
    markClut(r.asic);
    const line = rasterOf(0);
    r.asic.beginLine(line, 0);
    for (let i = 0; i < 5000; i++) {
      r.asic.writeClut(i & 15, i & 0x7F, (i % 48) * SAM_T_PER_CELL);
    }
    expect(() => r.asic.renderScanline(r.px, line)).not.toThrow();
    // The register file itself still tracks every write, for CPU read-back.
    expect(r.asic.clut[4999 & 15]).toBe(4999 & 0x7F);
  });

  it('starts each line with a clean journal', () => {
    const r = rig(4);
    markClut(r.asic);
    r.asic.borderIndex = 0;

    const l0 = rasterOf(0);
    r.asic.beginLine(l0, 0);
    r.asic.writeBorder(5, false, 2 * SAM_T_PER_CELL);
    r.asic.renderScanline(r.px, l0);

    // The next line inherits the *register* value, not the journal entry, so
    // it is uniformly the new colour rather than split again.
    const l1 = rasterOf(1);
    r.asic.beginLine(l1, 0);
    r.asic.renderScanline(r.px, l1);
    const row = r.px.subarray(l1 * SAM_SCREEN_WIDTH, (l1 + 1) * SAM_SCREEN_WIDTH);
    expect(row[0]).toBe(colour(5));
    expect(row[1 * SAM_CELL_PX]).toBe(colour(5));
  });
});

describe('SamAsic CLUT', () => {
  it('masks palette codes to 7 bits', () => {
    const r = rig(4);
    r.asic.writeClut(0, 0xFF, 0);
    expect(r.asic.clut[0]).toBe(0x7F);
  });

  it('wraps the entry index to 16 entries', () => {
    const r = rig(4);
    r.asic.writeClut(0x1F, 0x33, 0);
    expect(r.asic.clut[15]).toBe(0x33);
  });
});
