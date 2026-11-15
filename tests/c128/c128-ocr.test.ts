/**
 * The Commodore 128's TEXT overlay: the 40-column VIC-IIe screen read the way
 * the 64's is, and the 80-column VDC screen read from its own RAM and font.
 *
 * Expectations are worked out from the hardware, not from the implementation:
 * the 8563's register meanings (R1/R6 the display size, R22 the cell width with
 * its pitch in the high nibble and the shown part in the low one, R9 the row
 * pitch and R23 the scan lines shown, R28 the character set's base), the
 * attribute byte's bit layout, and the C128 Programmer's Reference Guide's
 * screen-code mapping. The frame is 704×248 and the grid is centred in it, so
 * the origins below are arithmetic on those numbers.
 */

import { describe, expect, it } from 'vitest';
import { Vdc, VDC_R } from '@/machines/c128/vdc.ts';
import { vdcGeometry, VDC_FRAME_HEIGHT, VDC_FRAME_WIDTH, VDC_PALETTE } from '@/machines/c128/vdc-display.ts';
import { vdcOcrGrid } from '@/machines/c128/vdc-ocr.ts';
import { C128Machine } from '@/machines/c128/c128-machine.ts';
import { c128Entry } from '@/machines/c128/descriptor.ts';

/** A diagonal and its mirror: two glyphs no other code in a blank font has. */
const DIAGONAL = [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01];
const ANTIDIAGONAL = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80];
const VERTICAL = [0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18];
const invert = (g: number[]): number[] => g.map(b => ~b & 0xFF);

const CHAR_BASE = 0x2000;

/**
 * A VDC with the editor's 80×25 geometry and a two-set font of our own at
 * `CHAR_BASE`. As in the real character ROM, each set's codes 128-255 are the
 * inverses of its 0-127 (the chip's reverse-video glyphs), and the second set
 * is the lower-case one: code 1 is `DIAGONAL` above and `VERTICAL` below, which
 * is how an 'A' and an 'a' differ by shape rather than by code alone.
 * Everything else in the font is blank.
 */
function vdc80(): Vdc {
  const v = new Vdc();
  const r = v.regs;
  r[VDC_R.HDISP] = 80;
  r[VDC_R.VDISP] = 25;
  r[VDC_R.CHARV] = 7;          // 8 scan lines to a row
  r[VDC_R.CHARH] = 0x78;       // 8 pixels across, all 8 shown
  r[VDC_R.CHAR_DISP_V] = 8;    // all 8 lines shown
  r[VDC_R.SCREEN_HI] = 0x00;
  r[VDC_R.SCREEN_LO] = 0x00;   // screen RAM at $0000
  r[VDC_R.ATTR_HI] = 0x08;
  r[VDC_R.ATTR_LO] = 0x00;     // attributes at $0800
  r[VDC_R.CHARSET] = 0x20;     // the set at $2000
  r[VDC_R.MODE] = 0x40;        // attributes on, text mode
  r[VDC_R.COLOUR] = 0xF0;      // border/background 0, foreground 15
  setGlyph(v, 0, 1, DIAGONAL);
  setGlyph(v, 0, 2, ANTIDIAGONAL);
  setGlyph(v, 1, 1, VERTICAL);
  setGlyph(v, 1, 2, ANTIDIAGONAL);
  return v;
}

/** Put a glyph in a set at a code, and its inverse 128 codes on. */
function setGlyph(v: Vdc, set: 0 | 1, code: number, glyph: number[]): void {
  const at = CHAR_BASE + set * 0x1000 + code * 16;
  v.ram.set(glyph, at);
  if (code < 128) v.ram.set(invert(glyph), at + 128 * 16);
}

/** Put `code` in a cell and give it `attr`. */
function place(v: Vdc, row: number, col: number, code: number, attr = 0x07): void {
  const r = v.regs;
  const stride = r[VDC_R.HDISP] + r[VDC_R.ROW_ADD];
  const cell = row * stride + col;
  v.ram[((r[VDC_R.SCREEN_HI] << 8) | r[VDC_R.SCREEN_LO]) + cell] = code;
  v.ram[((r[VDC_R.ATTR_HI] << 8) | r[VDC_R.ATTR_LO]) + cell] = attr;
}

const row0 = (text: string): string => text.split('\n')[0];

describe('the VDC grid\'s geometry comes from its registers', () => {
  it('takes the cell width from R22\'s two nibbles and the row pitch from R9/R23', () => {
    const v = new Vdc();
    v.regs[VDC_R.HDISP] = 80;
    v.regs[VDC_R.VDISP] = 25;
    v.regs[VDC_R.CHARH] = 0x78;   // pitch 7+1 = 8, shown 8
    v.regs[VDC_R.CHARV] = 7;      // pitch 7+1 = 8
    v.regs[VDC_R.CHAR_DISP_V] = 8;
    const g = vdcGeometry(v);
    expect(g).toMatchObject({ ok: true, cellTotalW: 8, cellW: 8, rowTotal: 8, rowShown: 8 });
    // 80 cells of 8 = 640, centred in 704: (704 - 640) / 2 = 32.
    // 25 rows of 8 = 200, centred in 248: (248 - 200) / 2 = 24.
    expect([g.x0, g.y0]).toEqual([32, 24]);
  });

  it('shows only the part of a cell R22 and R23 leave visible', () => {
    const v = new Vdc();
    v.regs[VDC_R.HDISP] = 40;
    v.regs[VDC_R.VDISP] = 20;
    v.regs[VDC_R.CHARH] = 0x62;   // pitch 6+1 = 7, 3 shown (2 + 1)
    v.regs[VDC_R.CHARV] = 0x0B;   // pitch 11+1 = 12
    v.regs[VDC_R.CHAR_DISP_V] = 5;   // 5 + 1 lines
    const g = vdcGeometry(v);
    expect(g).toMatchObject({ cellTotalW: 7, cellW: 3, rowTotal: 12, rowShown: 6 });
    // (704 - 40*7) / 2 = 212 and (248 - 20*12) / 2 = 4.
    expect([g.x0, g.y0]).toEqual([212, 4]);
  });

  it('reports no picture when the registers show no columns or rows', () => {
    const v = new Vdc();
    expect(vdcGeometry(v).ok).toBe(false);          // R1 and R6 are 0
    v.regs[VDC_R.HDISP] = 80;
    v.regs[VDC_R.CHARH] = 0x78;                     // 8 across, 8 shown
    expect(vdcGeometry(v).ok).toBe(false);          // no rows yet
    v.regs[VDC_R.VDISP] = 25;
    expect(vdcGeometry(v).ok, 'R23 0 shows one scan line').toBe(true);
    v.regs[VDC_R.CHAR_DISP_V] = 8;
    expect(vdcGeometry(v).ok, 'a blank screen is still a picture').toBe(true);
    // R22's low nibble equal to the high one shows no pixels at all.
    v.regs[VDC_R.CHARH] = 0x77;
    expect(vdcGeometry(v).ok, 'a cell with no pixels shown is no picture').toBe(false);
  });

  it('carries the smooth scrolls: up by R24, and right by R25 from its unscrolled value (R22 >> 4 on an 8563 R8/R9)', () => {
    const v = new Vdc();
    v.regs[VDC_R.CHARH] = 0x78;
    v.regs[VDC_R.MODE] = 0x40 | 5;   // 2 below the unscrolled 7: 2 pixels left
    v.regs[VDC_R.SCROLL_V] = 3;      // 3 lines up
    const g = vdcGeometry(v);
    expect([g.shiftX, g.vScroll]).toEqual([-2, 3]);
    v.version = 0;                   // an R7A is unscrolled at 0
    expect(vdcGeometry(v).shiftX).toBe(5);
  });
});

describe('the 80-column grid reads the VDC\'s screen RAM', () => {
  it('reads the character each cell holds, in the upper-case set', () => {
    const v = vdc80();
    place(v, 0, 0, 1);   // 'A'
    place(v, 0, 1, 2);   // 'B'
    const r = vdcOcrGrid(v);
    expect(row0(r.text).slice(0, 2)).toBe('AB');
    expect(r.mask.slice(0, 3)).toEqual([true, true, false]);
  });

  it('follows R27, which pads the end of each screen row', () => {
    const v = vdc80();
    v.regs[VDC_R.ROW_ADD] = 8;   // 8 bytes after the 80 visible cells
    // Row 1 therefore starts at 88, not 80.
    v.ram[88] = 2;
    const r = vdcOcrGrid(v);
    expect(r.text.split('\n')[1][0]).toBe('B');
  });

  it('reads the lower-case glyphs through the attribute\'s alternate-set bit', () => {
    const v = vdc80();
    place(v, 0, 0, 1, 0x07);            // set 0: 'A' (a diagonal)
    place(v, 0, 1, 1, 0x80 | 0x07);     // set 1: 'a' (a vertical bar)
    const r = vdcOcrGrid(v);
    expect(row0(r.text).slice(0, 2)).toBe('Aa');
  });

  it('swaps the ink and paper of a cell the attribute reverses', () => {
    const v = vdc80();
    place(v, 0, 0, 1, 0x47);   // reverse, foreground 7
    const r = vdcOcrGrid(v);
    expect(row0(r.text)[0]).toBe('A');
    // The cell is drawn as a white block with a hole, so it is blanked to the
    // foreground and its letter reads in the background.
    expect(r.paper[0]).toBe(7);
  });

  it('swaps them for an inverse glyph too, without the reverse bit', () => {
    const v = vdc80();
    place(v, 0, 0, 129, 0x07);   // code 129 is the inverse of code 1: a block with a diagonal hole
    const r = vdcOcrGrid(v);
    expect(row0(r.text)[0]).toBe('A');
    expect(r.paper[0], 'an inverse glyph is a block, blanked to its ink').toBe(7);
  });

  it('reads a bitmap mode as having no text at all', () => {
    const v = vdc80();
    place(v, 0, 0, 1);
    v.regs[VDC_R.MODE] |= 0x80;
    const r = vdcOcrGrid(v);
    expect(r.mask.some(Boolean)).toBe(false);
  });

  it('reads every cell as text when the attributes are switched off', () => {
    const v = vdc80();
    place(v, 0, 0, 1, 0x07);
    v.regs[VDC_R.MODE] = 0x00;   // attributes off: R26's high nibble is the ink
    v.regs[VDC_R.COLOUR] = 0xF1; // foreground 15, background 1
    const r = vdcOcrGrid(v);
    expect(row0(r.text)[0]).toBe('A');
    expect(r.paper[0]).toBe(1);
  });

  it('reports the cell size and grid label its registers describe', () => {
    const v = vdc80();
    v.regs[VDC_R.CHARH] = 0x63;
    v.regs[VDC_R.CHARV] = 0x0B;
    const r = vdcOcrGrid(v);
    expect(r).toMatchObject({ grid: '80x25', cols: 80, rows: 25, cellWidth: 7, cellHeight: 12 });
  });
});

describe('the machine paints the overlay over whichever screen is showing', () => {
  it('blanks exactly one VDC cell, leaving its neighbours alone', () => {
    const m = new C128Machine(null);
    const v = m.vdc;
    v.version = 0;              // an R7A: unscrolled at R25 = 0
    const r = v.regs;
    r[VDC_R.HDISP] = 40;
    r[VDC_R.VDISP] = 20;
    r[VDC_R.CHARH] = 0x62;      // 7 across, 3 shown
    r[VDC_R.CHARV] = 0x0B;      // 12 down
    r[VDC_R.CHAR_DISP_V] = 5;   // 6 shown (R23 + 1)
    m.setDisplayMode('80');
    expect(m.showing80).toBe(true);
    m.pixels.fill(0);
    const mask = new Array(40 * 20).fill(false);
    mask[0] = true;
    const paper = new Array(40 * 20).fill(0);
    paper[0] = 9;
    m.blankCells(mask, paper);
    const px = new Uint32Array(m.pixels.buffer);
    const x0 = 212, y0 = 4;     // from the geometry test above
    const fill = VDC_PALETTE[9];
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 3; x++) {
        expect(px[(y0 + y) * VDC_FRAME_WIDTH + x0 + x], `pixel ${x},${y}`).toBe(fill);
      }
    }
    // The fourth pixel across is the cell's unused pitch, and the seventh line
    // is past the rows R23 shows.
    expect(px[y0 * VDC_FRAME_WIDTH + x0 + 3]).toBe(0);
    expect(px[(y0 + 6) * VDC_FRAME_WIDTH + x0]).toBe(0);
    // The cell to the right is untouched.
    expect(px[y0 * VDC_FRAME_WIDTH + x0 + 7]).toBe(0);
  });

  it('places the 40-column text where the 64 does, and the 80-column text on the VDC grid', () => {
    // The 40-column screen: the display window's top-left at (32, 35) in the
    // 384×272 frame. The first text row starts three lines above the window, so
    // the KERNAL's YSCROLL of 3 cancels the -3 and lands the grid on the window.
    const m40 = new C128Machine(null);
    m40.vic.regs[0x11] = 3;
    m40.vic.regs[0x16] = 0;
    expect(m40.textField).toEqual({ x: 32, y: 35, width: 320, height: 200 });

    // The 80-column screen: 80 cells of 8 centred in 704, 25 rows of 8 centred
    // in 248.
    const m80 = new C128Machine(null);
    m80.vdc.version = 0;                       // an R7A: unscrolled at R25 = 0
    const r = m80.vdc.regs;
    r[VDC_R.HDISP] = 80;
    r[VDC_R.VDISP] = 25;
    r[VDC_R.CHARH] = 0x78;
    r[VDC_R.CHARV] = 7;
    r[VDC_R.CHAR_DISP_V] = 8;
    m80.setDisplayMode('80');
    expect(m80.textField).toEqual({ x: 32, y: 24, width: 640, height: 200 });
  });

  it('moves the 80-column field up by the vertical scroll and sideways by the horizontal one', () => {
    const m = new C128Machine(null);
    m.setDisplayMode('80');
    m.vdc.regs[VDC_R.HDISP] = 80;
    m.vdc.regs[VDC_R.VDISP] = 25;
    m.vdc.regs[VDC_R.CHARH] = 0x78;
    m.vdc.regs[VDC_R.CHARV] = 7;
    m.vdc.regs[VDC_R.CHAR_DISP_V] = 8;
    m.vdc.regs[VDC_R.MODE] = 0x40 | 2;
    m.vdc.regs[VDC_R.SCROLL_V] = 1;
    expect(m.textField, 'R25 2 against the unscrolled 7: 5 left').toMatchObject({ x: 27, y: 23 });
  });

  it('reads the 40-column screen from the 128\'s own character set', () => {
    // The 128's character ROM is two 4K sets, the 64's first and the 128's own
    // second. A cell whose glyph is drawn from the RAM set the VIC fetches must
    // read as that glyph's character whichever 4K the matcher was handed, so
    // this pins that the 128's set is the reference (the 64's holds a different
    // pattern at the code, which would read as something else).
    const m = new C128Machine(null);
    m.memory.chargen.set(DIAGONAL, 0x1000 + 8);     // 128 set, code 1
    m.memory.chargen.set(ANTIDIAGONAL, 0x0000 + 8); // 64 set, same code: different
    m.vic.regs[0x18] = 0x10;                        // screen $0400, characters $0000
    m.memory.ram.set(DIAGONAL, 0x0008);             // what the VIC fetches for code 1
    m.memory.ram[0x0400] = 1;
    expect(row0(m.ocrScreenStyled().text)[0]).toBe('A');
  });

  it('reads the 40-column screen from the 64\'s set in C64 mode', () => {
    const m = new C128Machine(null);
    m.memory.chargen.set(DIAGONAL, 0x1000 + 8);     // 128 set
    m.memory.chargen.set(ANTIDIAGONAL, 0x0000 + 8); // 64 set
    // MCR bit 6 is C64 mode; bits 4 and 5 always read high.
    m.memory.mmu.write(5, 0x40);
    expect(m.c64Mode).toBe(true);
    m.vic.regs[0x18] = 0x10;
    m.memory.ram.set(ANTIDIAGONAL, 0x0008);
    m.memory.ram[0x0400] = 1;
    expect(row0(m.ocrScreenStyled().text)[0], 'the 64\'s glyph for code 1').toBe('A');
  });

  it('marks the display dirty so the blanked cells reach the canvas', () => {
    const m = new C128Machine(null);
    m.setDisplayMode('80');
    // The base machine leaves the flag as it was after a render.
    (m as unknown as { needsDisplay: boolean }).needsDisplay = false;
    m.blankCells([false], [0]);
    expect((m as unknown as { needsDisplay: boolean }).needsDisplay).toBe(true);
  });
});

describe('the transcribe driver backs the TEXT LED', () => {
  it('is listed on the descriptor and provided by the probe', () => {
    expect(c128Entry.descriptor('c128').ui.statusLeds).toContain('text');
    const m = new C128Machine(null);
    expect(m.services.probe.transcribe).toBeDefined();
  });

  it('tracks whether it is switched on', () => {
    const m = new C128Machine(null);
    const t = m.services.probe.transcribe!;
    expect(t.active).toBe(false);
    t.activate();
    expect(t.active).toBe(true);
    t.deactivate();
    expect(t.active).toBe(false);
  });

  it('returns the grid and field of the screen it read, and blanks it', () => {
    const m = new C128Machine(null);
    const v = m.vdc;
    v.version = 0;                             // an R7A: unscrolled at R25 = 0 (the $40 is attributes)
    v.regs[VDC_R.HDISP] = 80;
    v.regs[VDC_R.VDISP] = 25;
    v.regs[VDC_R.CHARH] = 0x78;
    v.regs[VDC_R.CHARV] = 7;
    v.regs[VDC_R.CHAR_DISP_V] = 8;
    v.regs[VDC_R.MODE] = 0x40;
    v.regs[VDC_R.CHARSET] = 0x20;
    v.ram.set(DIAGONAL, CHAR_BASE + 1 * 16);   // code 1 of set 0
    v.ram[0] = 1;                              // and that code in row 0, col 0
    v.ram[0x800] = 0x07;                       // its attribute: foreground 7
    m.setDisplayMode('80');
    // Draw the cell's glyph, so the frame holds ink for the overlay to replace.
    const px = new Uint32Array(m.pixels.buffer);
    px.fill(0);
    const field = m.textField;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if ((DIAGONAL[y] >> (7 - x)) & 1) px[(field.y + y) * VDC_FRAME_WIDTH + field.x + x] = VDC_PALETTE[15];
      }
    }
    const t = m.services.probe.transcribe!;
    t.activate();
    const out = t.run();
    expect(out.grid).toBe('80x25');
    expect(out.text.split('\n')[0][0]).toBe('A');
    expect(out.field).toEqual({ x: 32, y: 24, width: 640, height: 200 });
    // The matched cell was painted out with R26's background.
    expect(px[24 * VDC_FRAME_WIDTH + 32]).toBe(VDC_PALETTE[0]);
    expect(px[(24 + 7) * VDC_FRAME_WIDTH + 32 + 1], 'the diagonal\'s last ink').toBe(VDC_PALETTE[0]);
  });

  it('reports the 40-column grid and field on the VIC-IIe screen', () => {
    const m = new C128Machine(null);
    m.memory.chargen.set(DIAGONAL, 0x1000 + 8);
    m.vic.regs[0x18] = 0x10;
    m.memory.ram.set(DIAGONAL, 0x0008);
    m.memory.ram[0x0400] = 1;
    m.vic.regs[0x11] = 3;   // the KERNAL's YSCROLL, which the field cancels
    const t = m.services.probe.transcribe!;
    t.activate();
    const out = t.run();
    expect(out.grid).toBe('40x25');
    expect(out.field).toEqual({ x: 32, y: 35, width: 320, height: 200 });
  });
});

/** The padding conformance test: the frame the overlay is positioned against. */
describe('the frame the overlay is measured in', () => {
  it('is the VDC frame while the 80-column screen is shown', () => {
    const m = new C128Machine(null);
    m.setDisplayMode('80');
    expect([m.frameWidth, m.frameHeight]).toEqual([VDC_FRAME_WIDTH, VDC_FRAME_HEIGHT]);
    m.setDisplayMode('40');
    expect([m.frameWidth, m.frameHeight]).toEqual([384, 272]);
  });
});
