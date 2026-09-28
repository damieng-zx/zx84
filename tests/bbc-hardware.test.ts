/**
 * BBC hardware tests: SAA5050 teletext generation, the sheila IO decode, the
 * IC32 addressable latch, the keyboard links and the video ULA registers.
 *
 * Expectations for the SAA5050 come from the teletext control-code rules and
 * the mosaic cell geometry, not from the implementation.
 */

import { describe, it, expect } from 'vitest';
import { Saa5050, createSaa5050Cells } from '@/cores/saa5050.ts';
import { SAA5050_FONT, SAA5050_GLYPH_ROWS } from '@/cores/saa5050-font.ts';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { writeIc32 } from '@/machines/bbc/bbc-io.ts';
import {
  BBC_BORDER_LEFT, BBC_BORDER_TOP, BBC_SCREEN_WIDTH,
} from '@/machines/bbc/constants.ts';

function makeBbc(): BbcMachine {
  return new BbcMachine('bbc-b', null);
}

function saaRow(...bytes: number[]) {
  const saa = new Saa5050();
  const cells = createSaa5050Cells(bytes.length);
  saa.renderRow(Uint8Array.from(bytes), bytes.length, cells);
  return cells;
}

describe('saa5050 — alpha', () => {
  it('doubles the 5x9 glyph to a 12x20 cell', () => {
    const cells = saaRow(0x41); // 'A'
    expect(cells[0].pixels.length).toBe(20);
    // Every row is a 12-bit pattern; the unrounded doubling of the glyph is a
    // subset of the (diagonally rounded) output.
    const base = (0x41 - 0x20) * SAA5050_GLYPH_ROWS;
    for (let ra = 0; ra < 20; ra++) {
      const row = ra >> 1;
      const src = row < SAA5050_GLYPH_ROWS ? SAA5050_FONT[base + row] & 0x1F : 0;
      let doubled = 0;
      for (let i = 0; i < 5; i++) if (src & (1 << i)) doubled |= 3 << (2 * i);
      expect(cells[0].pixels[ra] & doubled).toBe(doubled);
      expect(cells[0].pixels[ra]).toBeLessThanOrEqual(0xFFF);
    }
    // Default teletext colours are white on black.
    expect(cells[0].fg).toBe(7);
    expect(cells[0].bg).toBe(0);
  });

  it('character rounding fills the half-dot between diagonal neighbours', () => {
    // A dot at column 0 on one row and column 1 on the next: the corner
    // between them (bit 2) is filled.
    expect(Saa5050.characterRounding(0b0000000011, 0b0000001100)).toBe(0b0000000111);
    // Identical rows are unchanged.
    expect(Saa5050.characterRounding(0b0000000011, 0b0000000011)).toBe(0b0000000011);
  });

  it('a colour control code changes the colour of following cells', () => {
    const cells = saaRow(0x01, 0x41); // alpha red, then 'A'
    expect(cells[1].fg).toBe(1);
    expect(cells[0].pixels.every(p => p === 0)).toBe(true); // control cell blank
  });

  it('0x1D sets the background to the current foreground', () => {
    const cells = saaRow(0x02, 0x1D, 0x41); // alpha green, new background
    expect(cells[2].fg).toBe(2);
    expect(cells[2].bg).toBe(2);
  });
});

describe('saa5050 — mosaics', () => {
  it('renders a contiguous 2×3 mosaic from the six bits', () => {
    const cells = saaRow(0x0B, 0x3F); // mosaic yellow, all six blocks
    expect(cells[1].fg).toBe(3);
    for (let r = 0; r < 20; r++) expect(cells[1].pixels[r]).toBe(0xFFF);
  });

  it('a separated mosaic leaves gaps', () => {
    const cells = saaRow(0x1B, 0x3F); // separated mosaic yellow, all six blocks
    expect(cells[1].fg).toBe(3);
    // Top block row: columns 0,1 and 4,5 lit -> 0x33 doubled to 0xF0F.
    expect(cells[1].pixels[0]).toBe(0xF0F);
    expect(cells[1].pixels[2]).toBe(0xF0F);
    // The one-line gap below the top block lands on doubled rows 4-5.
    expect(cells[1].pixels[4]).toBe(0x000);
  });
});

describe('bbc — sheila IO decode', () => {
  it('routes CRTC register select/data writes', () => {
    const m = makeBbc();
    try {
      m.memory.writeByte(0xFE00, 12);
      m.memory.writeByte(0xFE01, 0x30);
      expect(m.crtc.regs[12]).toBe(0x30);
      expect(m.crtc.displayStart).toBe(0x3000);
    } finally {
      m.destroy();
    }
  });

  it('latches the sideways ROM selection', () => {
    const m = makeBbc();
    try {
      m.memory.writeByte(0xFE30, 0x0E);
      expect(m.memory.romsel).toBe(0x0E);
      m.memory.writeByte(0xFE30, 0x8F); // low nibble selects ROM 15
      expect(m.memory.romsel).toBe(0x0F);
    } finally {
      m.destroy();
    }
  });

  it('stores the video ULA control and maps palette writes (physical EOR 7)', () => {
    const m = makeBbc();
    try {
      m.memory.writeByte(0xFE20, 0x9C);   // mode 0: 2 colours
      expect(m.videoUlaControl).toBe(0x9C);
      m.memory.writeByte(0xFE21, 0x07);   // bit 7 clear -> logical 0, physical 7 EOR 7 = 0
      m.memory.writeByte(0xFE21, 0x85);   // bit 7 set   -> logical 1, physical 5 EOR 7 = 2
      expect(m.palette[0]).toBe(0);
      expect(m.palette[1]).toBe(2);
    } finally {
      m.destroy();
    }
  });

  it('reads the System VIA IER at 0xFE4E', () => {
    const m = makeBbc();
    try {
      m.sysVia.ier = 0x40;
      expect(m.memory.readByte(0xFE4E) & 0x7F).toBe(0x40);
      expect(m.memory.readByte(0xFE4E) & 0x80).toBe(0x80);
    } finally {
      m.destroy();
    }
  });
});

describe('bbc — IC32 addressable latch', () => {
  it('decodes sound / keyboard-scan / C0-C1 / locks from port B writes', () => {
    const m = makeBbc();
    try {
      writeIc32(m, 0x0C, 0x0F); // latch 4 = 1 -> C0
      writeIc32(m, 0x0D, 0x0F); // latch 5 = 1 -> C1
      writeIc32(m, 0x0B, 0x0F); // latch 3 = 1 -> keyboard scan on
      writeIc32(m, 0x00, 0x0F); // latch 0 = 0 -> sound enabled
      expect(m.ic32.c0).toBe(1);
      expect(m.ic32.c1).toBe(1);
      expect(m.ic32.keyboardScan).toBe(true);
      expect(m.ic32.soundEnabled).toBe(true);
      writeIc32(m, 0x08, 0x0F); // latch 0 = 1 -> sound disabled
      expect(m.ic32.soundEnabled).toBe(false);
    } finally {
      m.destroy();
    }
  });
});

describe('bbc — keyboard', () => {
  it('reports no key pressed as bit 7 low', () => {
    const m = makeBbc();
    try {
      // Column 1, row 0 (CTRL) — not a fitted link, so it reads up (0).
      m.sysVia.ora = 0x01;
      m.sysVia.ddra = 0x7F;
      expect(m.memory.readByte(0xFE4F) & 0x80).toBe(0);
    } finally {
      m.destroy();
    }
  });

  it('maps a host key to its matrix cell', () => {
    const m = makeBbc();
    try {
      m.services.input.keyDown({ code: 'KeyA', key: 'a', shift: false, ctrl: false, alt: false });
      expect(m.keyboard.isDown(1, 4)).toBe(true); // 'A' = column 1, row 4
      m.services.input.keyUp({ code: 'KeyA', key: 'a', shift: false, ctrl: false, alt: false });
      expect(m.keyboard.isDown(1, 4)).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('routes symbols by the produced character (BBC layout)', () => {
    const m = makeBbc();
    try {
      // Host Shift+8 yields '*' but the BBC's '*' is Shift on its ':' key.
      m.services.input.keyDown({ code: 'Digit8', key: '*', shift: true, ctrl: false, alt: false });
      expect(m.keyboard.isDown(8, 4)).toBe(true);   // the BBC '*'/':' key
      expect(m.keyboard.isDown(0, 0)).toBe(true);   // SHIFT asserted
      expect(m.keyboard.isDown(5, 1)).toBe(false);  // not the '8' key
      m.services.input.keyUp({ code: 'Digit8', key: '*', shift: true, ctrl: false, alt: false });

      // Host '8' still lands on the BBC '8' key, unshifted.
      m.services.input.keyDown({ code: 'Digit8', key: '8', shift: false, ctrl: false, alt: false });
      expect(m.keyboard.isDown(5, 1)).toBe(true);
      expect(m.keyboard.isDown(0, 0)).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('exposes the fitted option links on row 0', () => {
    const m = makeBbc();
    try {
      // A stock Model B has no links fitted (*FX255 reads &FF: Mode 7, and
      // SHIFT+BREAK boots), so row 0 columns 2-9 read open.
      for (let col = 2; col <= 9; col++) expect(m.keyboard.isDown(col, 0)).toBe(false);
      // Link bit 0 is column 2, bit 7 column 9.
      m.keyboard.links = 0x81;
      expect(m.keyboard.isDown(2, 0)).toBe(true);
      expect(m.keyboard.isDown(3, 0)).toBe(false);
      expect(m.keyboard.isDown(9, 0)).toBe(true);
    } finally {
      m.destroy();
    }
  });

  it('sets cells directly for the on-screen keyboard', () => {
    const m = makeBbc();
    try {
      m.keyboard.setCell(1, 4, true);
      expect(m.keyboard.isPressed(1, 4)).toBe(true);
      expect(m.keyboard.isDown(1, 4)).toBe(true);
      expect(m.keyboard.anyInColumn(1)).toBe(true);
      m.keyboard.setCell(1, 4, false);
      expect(m.keyboard.isPressed(1, 4)).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('asserts CA2 for a column holding any pressed key', () => {
    const m = makeBbc();
    try {
      // 'A' lives at column 1, row 4: the exact cell is not the row-0 one, but
      // the column still asserts CA2 (this gates the MOS's column scan).
      m.services.input.keyDown({ code: 'KeyA', key: 'a', shift: false, ctrl: false, alt: false });
      expect(m.keyboard.isDown(1, 0)).toBe(false);
      expect(m.keyboard.anyInColumn(1)).toBe(true);
      expect(m.keyboard.anyInColumn(0)).toBe(false);
    } finally {
      m.destroy();
    }
  });
});

describe('bbc — sound', () => {
  it('latches the port A byte into the SN76489 when IC32 latch 0 strobes /WE', () => {
    const m = makeBbc();
    try {
      const written: number[] = [];
      const write = m.psg.write.bind(m.psg);
      m.psg.write = (v: number) => { written.push(v); write(v); };
      // The MOS sequence: byte onto the slow bus first, then /WE low, then high.
      m.sysVia.ddra = 0xFF;             // all port A bits outputs (slow bus)
      m.memory.writeByte(0xFE4F, 0x8F);
      expect(written).toEqual([]);      // not yet strobed
      writeIc32(m, 0x00, 0x0F);         // latch 0 = 0 -> /WE low
      writeIc32(m, 0x08, 0x0F);         // latch 0 = 1 -> /WE high
      expect(written).toEqual([0x8F]);
    } finally {
      m.destroy();
    }
  });

  it('does not write the SN76489 while sound is disabled', () => {
    const m = makeBbc();
    try {
      m.sysVia.ddra = 0xFF;
      m.memory.writeByte(0xFE4F, 0x8F);
      expect(m.activity.psgWrites).toBe(0);
    } finally {
      m.destroy();
    }
  });
});

describe('bbc — Mode 7 at one line per scanline', () => {
  /** RGB at picture (x, y) — the helpers above add the border. */
  function rgbAt(m: BbcMachine, x: number, y: number): [number, number, number] {
    const i = ((y + BBC_BORDER_TOP) * BBC_SCREEN_WIDTH + x + BBC_BORDER_LEFT) * 4;
    return [m.pixels[i], m.pixels[i + 1], m.pixels[i + 2]];
  }

  it('blends each half-line pair: both lit = ink, one = 50%, none = paper', () => {
    const m = makeBbc();
    try {
      m.videoUlaControl = 0x02;           // teletext
      m.crtc.regs[1] = 40;
      m.crtc.regs[12] = 0x28;             // MA 0x2800 -> RAM 0x7C00
      m.crtc.regs[13] = 0x00;
      // Draw from the real SAA5050 rows for 'A' (white on black) so the
      // expectation comes from the glyph, not from the renderer under test.
      m.memory.ram[0x7C00] = 0x41;
      const saa = new Saa5050();
      const cells = createSaa5050Cells(1);
      saa.renderRow(Uint8Array.of(0x41), 1, cells);
      const rows = cells[0].pixels;
      m.video.render(m);
      const x0 = 80, y0 = 3;              // the 480×250 box centred in 640×256
      let seenHalf = false;
      for (let y = 0; y < 10; y++) {
        for (let x = 0; x < 12; x++) {
          const lit = ((rows[y * 2] >> x) & 1) + ((rows[y * 2 + 1] >> x) & 1);
          const want = lit === 2 ? 255 : lit === 1 ? 127 : 0;
          if (lit === 1) seenHalf = true;
          expect(rgbAt(m, x0 + x, y0 + y)).toEqual([want, want, want]);
        }
      }
      expect(seenHalf).toBe(true);        // 'A' has rounded (half-lit) pixels
    } finally {
      m.destroy();
    }
  });
});

describe('bbc — bitmap modes', () => {
  /** Point the CRTC at a Mode 4 screen at RAM 0x5800 and set a 2-colour palette. */
  function setupMode4(m: BbcMachine): void {
    m.videoUlaControl = 0x89;   // 40 cols, low clock -> mode 4 (2 colours)
    m.crtc.regs[1] = 40;        // MA units per line
    m.crtc.regs[6] = 32;        // character rows
    m.crtc.regs[9] = 7;         // 8 scanlines per character row
    m.crtc.regs[12] = 0x0B;     // display start 0xB00 -> 0x5800
    m.crtc.regs[13] = 0x00;
    m.palette[0] = 0;
    m.palette[1] = 7;
  }

  // 32 rows x 8 scanlines exactly fill the 256-line picture, one buffer line
  // per scanline. Coordinates below are within the picture; the helpers add
  // the border.
  const firstY = 0;

  function rowOn(m: BbcMachine, y: number, x0: number, x1: number): number {
    let n = 0;
    for (let x = x0; x < x1; x++) {
      const i = ((y + BBC_BORDER_TOP) * BBC_SCREEN_WIDTH + x + BBC_BORDER_LEFT) * 4;
      if (m.pixels[i] | m.pixels[i + 1] | m.pixels[i + 2]) n++;
    }
    return n;
  }

  it('renders each scanline from its cell-major byte', () => {
    const m = makeBbc();
    try {
      setupMode4(m);
      m.memory.ram[0x5800] = 0xFF;   // cell 0, scanline 0: all 8 pixels lit
      m.video.render(m);
      // A 320-wide mode is doubled to 640, so the 8-pixel cell covers x 0-15.
      expect(rowOn(m, firstY, 0, 16)).toBe(16);
      // Scanline 1 lives in the NEXT byte, not the next 40-pixel run.
      expect(rowOn(m, firstY + 1, 0, 16)).toBe(0);
    } finally {
      m.destroy();
    }
  });

  it('blanks the two gap scanlines of a 10-line text-mode row (modes 3/6)', () => {
    const m = makeBbc();
    try {
      setupMode4(m);
      m.crtc.regs[6] = 25;        // 25 rows ...
      m.crtc.regs[9] = 9;         // ... of 10 scanlines (8 lit + 2 blank)
      // Fill the whole first row so every scanline 0-7 is lit.
      for (let i = 0; i < 40 * 8; i++) m.memory.ram[0x5800 + i] = 0xFF;
      m.video.render(m);
      // 25 rows x 10 = 250 scanlines, centred in 256: 3 lines of margin on top.
      const top = (256 - 250) / 2;
      expect(rowOn(m, top - 1, 0, 16)).toBe(0);
      expect(rowOn(m, top, 0, 16)).toBe(16);
      expect(rowOn(m, top + 7, 0, 16)).toBe(16);    // scanline 7
      expect(rowOn(m, top + 8, 0, 16)).toBe(0);     // scanline 8: gap
      expect(rowOn(m, top + 9, 0, 16)).toBe(0);     // scanline 9: gap
    } finally {
      m.destroy();
    }
  });

  it('steps the row address by R1, not by a linear scanline width', () => {
    const m = makeBbc();
    try {
      setupMode4(m);
      m.memory.ram[0x5808] = 0xFF;   // second cell's scanline 0
      m.video.render(m);
      expect(rowOn(m, firstY, 0, 16)).toBe(0);
      expect(rowOn(m, firstY, 16, 32)).toBe(16);
    } finally {
      m.destroy();
    }
  });

  it('decodes the 2-colour ULA palette field', () => {
    const m = makeBbc();
    try {
      m.memory.writeByte(0xFE20, 0x89);   // mode 4: 2 colours
      m.memory.writeByte(0xFE21, 0x07);   // bit 7 = 0 -> logical 0, physical 0
      m.memory.writeByte(0xFE21, 0x80);   // bit 7 = 1 -> logical 1, physical 7
      expect(m.palette[0]).toBe(0);
      expect(m.palette[1]).toBe(7);
    } finally {
      m.destroy();
    }
  });

  it('aliases the whole 0xFE20-0xFE2F window to the two ULA registers', () => {
    const m = makeBbc();
    try {
      // Only A0 selects control (even) vs palette (odd); the rest of the nibble
      // is not decoded — Acorn DFS probes 0xFE28/0xFE29 with a write/read-back.
      m.memory.writeByte(0xFE2E, 0x4b);   // even -> control register
      m.memory.writeByte(0xFE2F, 0x07);   // odd  -> palette register
      expect(m.memory.readByte(0xFE20)).toBe(0x4b);
      expect(m.memory.readByte(0xFE29)).toBe(0x07);
      expect(m.memory.readByte(0xFE21)).toBe(0x07);
    } finally {
      m.destroy();
    }
  });

  /** Physical colour index at framebuffer (x, y), recovered from the RGBA. */
  function physAt(m: BbcMachine, x: number, y: number): number {
    const i = ((y + BBC_BORDER_TOP) * BBC_SCREEN_WIDTH + x + BBC_BORDER_LEFT) * 4;
    const pal = [
      [0, 0, 0], [255, 0, 0], [0, 255, 0], [255, 255, 0],
      [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ];
    for (let k = 0; k < 8; k++) {
      if (m.pixels[i] === pal[k][0] && m.pixels[i + 1] === pal[k][1] && m.pixels[i + 2] === pal[k][2]) return k;
    }
    return -1;
  }

  it('unpacks 2bpp pixels by interleaving the bits across the byte', () => {
    const m = makeBbc();
    try {
      // Mode 1: high clock, 40 columns -> 2bpp, 320px (scale 2).
      m.videoUlaControl = 0x18;
      m.crtc.regs[1] = 40;
      m.crtc.regs[6] = 32;
      m.crtc.regs[9] = 7;
      m.crtc.regs[12] = 0x0B;     // display start 0xB00 -> 0x5800
      m.crtc.regs[13] = 0x00;
      for (let i = 0; i < 4; i++) m.palette[i] = i;
      // Byte 0b01100101: pixel bits are B7+B3, B6+B2, B5+B1, B4+B0.
      m.memory.ram[0x5800] = 0b01100101;
      m.video.render(m);
      const y = firstY;
      // Expected physical colours 0,3,2,1 — each pixel doubled to scale 2.
      expect([physAt(m, 0, y), physAt(m, 1, y), physAt(m, 2, y), physAt(m, 3, y)])
        .toEqual([0, 0, 3, 3]);
      expect([physAt(m, 4, y), physAt(m, 5, y), physAt(m, 6, y), physAt(m, 7, y)])
        .toEqual([2, 2, 1, 1]);
    } finally {
      m.destroy();
    }
  });

  it('unpacks 4bpp pixels by interleaving the bits across the byte', () => {
    const m = makeBbc();
    try {
      // Mode 2: high clock, 20 columns -> 4bpp, 160px (scale 4).
      m.videoUlaControl = 0x14;
      m.crtc.regs[1] = 40;
      m.crtc.regs[6] = 32;
      m.crtc.regs[9] = 7;
      m.crtc.regs[12] = 0x0B;
      m.crtc.regs[13] = 0x00;
      for (let i = 0; i < 16; i++) m.palette[i] = i % 8;
      m.palette[10] = 6;   // distinguish the two decodes: 6 (cyan) vs 1 (red)
      m.palette[1] = 3;    //                                    3 (yellow)
      // Byte 0b10001001: pixel 0 = B7 B5 B3 B1 = 1010 = 10; pixel 1 = B6 B4 B2 B0 = 0001 = 1.
      m.memory.ram[0x5800] = 0b10001001;
      m.video.render(m);
      const y = firstY;
      expect(physAt(m, 0, y)).toBe(6);   // logical 10 -> palette 6
      expect(physAt(m, 3, y)).toBe(6);
      expect(physAt(m, 4, y)).toBe(3);   // logical 1 -> palette 3
      expect(physAt(m, 7, y)).toBe(3);
    } finally {
      m.destroy();
    }
  });
});

function nonBlackPixels(m: BbcMachine): number {
  const px = m.pixels;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] | px[i + 1] | px[i + 2]) n++;
  return n;
}

/** Point the CRTC at a Mode 7 screen at RAM 0x7C00 and blank it to spaces. */
function setupMode7(m: BbcMachine): void {
  m.videoUlaControl = 0x4B;   // teletext
  m.crtc.regs[1] = 40;        // R1 = 40 columns
  m.crtc.regs[12] = 0x28;     // display start 0x2800 -> 0x7C00
  m.crtc.regs[13] = 0x00;
  m.memory.ram.fill(0x20, 0x7C00, 0x7C00 + 1000);
}

describe('bbc — Mode 7 rendering', () => {
  it('draws teletext text into the framebuffer', () => {
    const m = makeBbc();
    try {
      setupMode7(m);
      m.memory.ram[0x7C00] = 0x41; // 'A'
      m.video.render(m);
      expect(nonBlackPixels(m)).toBeGreaterThan(0);
    } finally {
      m.destroy();
    }
  });

  it('steps rows by R1 (40), not R0+1', () => {
    const m = makeBbc();
    try {
      setupMode7(m);
      // Only row 1's first cell holds a glyph. With the correct stride, row 1
      // reads 0x7C28; a 64-byte stride would read 0x7C40 and draw nothing.
      m.memory.ram[0x7C28] = 0x41;
      m.video.render(m);
      expect(nonBlackPixels(m)).toBeGreaterThan(0);
    } finally {
      m.destroy();
    }
  });

  it('resets the SAA5050 colour state each field', () => {
    const m = makeBbc();
    try {
      setupMode7(m);
      // First field: row 0 begins with an alpha-black control code, so a glyph
      // on row 1 renders black. Replacing it and rendering again must recover
      // (a stale per-frame colour state would keep it black).
      m.memory.ram[0x7C00] = 0x00;
      m.memory.ram[0x7C28] = 0x41;
      m.video.render(m);
      m.memory.ram[0x7C00] = 0x20;
      m.video.render(m);
      expect(nonBlackPixels(m)).toBeGreaterThan(0);
    } finally {
      m.destroy();
    }
  });
});
