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
      m.memory.writeByte(0xFE20, 0x4B);
      expect(m.videoUlaControl).toBe(0x4B);
      // Logical colour 1 -> physical 5 EOR 7 = 2.
      m.memory.writeByte(0xFE21, 0x15);
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

  it('exposes the fitted option links on row 0', () => {
    const m = makeBbc();
    try {
      // Default 0x1F: link bit 0 (column 2) fitted, bit 7 (column 9) open.
      expect(m.keyboard.isDown(2, 0)).toBe(true);
      expect(m.keyboard.isDown(9, 0)).toBe(false);
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
