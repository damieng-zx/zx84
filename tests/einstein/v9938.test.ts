import { describe, it, expect, beforeEach } from 'vitest';
import { V9938, V9938_WIDTH } from '@/cores/v9938.ts';

/** Write a register through the port-1 two-byte sequence. */
function setReg(v: V9938, reg: number, val: number): void {
  v.writeControl(val);
  v.writeControl(0x80 | reg);
}

/** Set the 17-bit VRAM address: R14 then the 14-bit latch (write intent). */
function setAddress(v: V9938, addr: number, write = true): void {
  setReg(v, 14, (addr >> 14) & 7);
  v.writeControl(addr & 0xFF);
  v.writeControl((write ? 0x40 : 0x00) | ((addr >> 8) & 0x3F));
}

describe('V9938 CPU port interface', () => {
  let v: V9938;
  beforeEach(() => { v = new V9938(); v.reset(); });

  it('writes registers via port 1 with data-book masking', () => {
    setReg(v, 1, 0xFF);
    expect(v.regs[1]).toBe(0x7B);          // R1 mask: bits 2/7 discarded
    setReg(v, 14, 0xFF);
    expect(v.regs[14]).toBe(0x07);         // R14 is 3 bits
  });

  it('treats R25-R27 as absent on a V9938', () => {
    setReg(v, 25, 0x7F);
    setReg(v, 26, 0x3F);
    setReg(v, 27, 0x07);
    expect(Array.from(v.regs.slice(25, 28))).toEqual([0, 0, 0]);
  });

  it('writes and reads back VRAM with auto-increment across a 16KB page', () => {
    setAddress(v, 0x0000);
    v.writeData(0x11);
    v.writeData(0x22);
    expect(v.vram[0]).toBe(0x11);
    expect(v.vram[1]).toBe(0x22);

    // Read setup: the first data read returns the prefetched byte.
    setAddress(v, 0x0000, false);
    expect(v.readData()).toBe(0x11);
    expect(v.readData()).toBe(0x22);
  });

  it('uses R14 for address bits 14–16 (full 128KB main VRAM)', () => {
    setAddress(v, 0x1FFFF);                // top byte of the 128KB main bank
    v.writeData(0x99);
    expect(v.vram[0x1FFFF]).toBe(0x99);
    expect(v.vram[0x0FFFF]).toBe(0);       // not aliased into the low 64KB
  });

  it('does not increment R14 on latch wrap in the TMS-compatible modes', () => {
    setReg(v, 0, 0x00);                    // G1: M4/M5 clear
    setAddress(v, 0x3FFF);
    v.writeData(0xAA);
    v.writeData(0xBB);                     // wraps the 14-bit latch to 0
    expect(v.regs[14]).toBe(0);            // R14 stays
    expect(v.vram[0x0000]).toBe(0xBB);     // wrapped within the 16KB page
  });

  it('increments R14 on latch wrap in the G4+ modes (R0 M4/M5 set)', () => {
    setReg(v, 0, 0x04);                    // M4 set
    setAddress(v, 0x3FFF);
    v.writeData(0xAA);
    v.writeData(0xBB);
    expect(v.regs[14]).toBe(1);
    expect(v.vram[0x4000]).toBe(0xBB);     // continued into the next page
  });

  it('routes CPU-port access to the 64KB expansion bank when R45 MXM is set', () => {
    setReg(v, 45, 0x40);
    setAddress(v, 0x0000);
    v.writeData(0x5A);
    expect(v.vram[0x20000]).toBe(0x5A);    // expansion base
    expect(v.vram[0x00000]).toBe(0);       // main bank untouched
    // Address bit 16 floats: reads 0xFF, writes ignored.
    setAddress(v, 0x10000);
    v.writeData(0x77);
    setAddress(v, 0x10000, false);
    expect(v.readData()).toBe(0xFF);
    expect(v.vram[0x20000]).toBe(0x5A);
  });

  it('writes palette entries as two bytes and auto-increments R16', () => {
    setReg(v, 16, 0);
    v.writePalette(0x77);                  // R=7, B=7
    v.writePalette(0x07);                  // G=7
    expect(v.pens[0]).toBe(0xFFFFFFFF);    // 7,7,7 → white (ABGR opaque)
    expect(v.regs[16]).toBe(1);            // next entry
    v.writePalette(0x70);                  // R=7
    v.writePalette(0x00);
    expect(v.pens[1]).toBe(0xFF0000FF);    // pure red (ABGR)
  });

  it('wraps the R16 palette index after entry 15', () => {
    setReg(v, 16, 15);
    v.writePalette(0x00);
    v.writePalette(0x00);
    expect(v.regs[16]).toBe(0);
  });

  it('an unrelated register write (R15) does not reset the palette write latch', () => {
    setReg(v, 16, 0);
    v.writePalette(0xAA);                  // first of two bytes — latch pending
    setReg(v, 15, 1);                      // selects a status register; must not disturb it
    v.writePalette(0xBB);                  // completes the pending two-byte write
    expect(v.pens[0]).not.toBe(0xFF000000); // reset-default black — proves the write landed
  });

  it('writing R16 does reset the palette write latch', () => {
    setReg(v, 16, 0);
    v.writePalette(0xAA);                  // first of two bytes — latch pending
    setReg(v, 16, 5);                      // re-selecting the index resets the latch
    const before = v.pens[5];
    v.writePalette(0xBB);                  // treated as a fresh first byte, not the second
    expect(v.pens[5]).toBe(before);        // unwritten — one byte alone can't complete an entry
  });

  it('writes registers indirectly through port 3 / R17', () => {
    setReg(v, 17, 1);
    v.writeRegister(0x60);
    expect(v.regs[1]).toBe(0x60);
    expect(v.regs[17]).toBe(2);            // auto-increment
    // R17 bit7 freezes the auto-increment …
    setReg(v, 17, 0x80 | 3);
    v.writeRegister(0x7F);
    expect(v.regs[3]).toBe(0x7F);
    expect(v.regs[17]).toBe(0x83);
    // … and port 3 never writes R17 itself.
    setReg(v, 17, 17);
    v.writeRegister(0x00);
    expect(v.regs[17]).toBe(18);
  });
});

describe('V9938 status registers and frame interrupt', () => {
  let v: V9938;
  beforeEach(() => { v = new V9938(); v.reset(); });

  it('raises F at end of active display; reading S0 returns and clears it', () => {
    expect(v.readStatus() & 0x80).toBe(0);
    v.endActiveDisplay();
    expect(v.readStatus() & 0x80).toBe(0x80);
    expect(v.readStatus() & 0x80).toBe(0); // cleared by the read
  });

  it('gates INT on R1 IE1 and holds it until S0 is read', () => {
    setReg(v, 1, 0x40);                    // BL set, IE1 clear
    v.endActiveDisplay();
    expect(v.interruptPending()).toBe(false);
    setReg(v, 1, 0x60);                    // IE1 set
    expect(v.interruptPending()).toBe(true);
    expect(v.readStatus() & 0x80).toBe(0x80);
    expect(v.interruptPending()).toBe(false);
  });

  it('reports S1 = 0 (a V9938, not a V9958)', () => {
    setReg(v, 15, 1);
    expect(v.readStatus()).toBe(0);
  });

  it('tracks the retrace period and field flag in S2', () => {
    setReg(v, 15, 2);
    expect(v.readStatus() & 0x40).toBe(0); // VR clear inside the display
    v.endActiveDisplay();
    expect(v.readStatus() & 0x40).toBe(0x40);
    const eo1 = v.readStatus() & 0x02;
    v.endActiveDisplay();
    expect(v.readStatus() & 0x02).toBe(eo1 ^ 0x02); // EO toggles per frame
    v.beginFrame();
    expect(v.readStatus() & 0x40).toBe(0);
  });

  it('asserts HR (S2 bit 5) at least once across repeated status reads', () => {
    // Real hardware toggles HR once per scanline; this core has no sub-line
    // T-state granularity to time it exactly, so it synthesises a toggling
    // pattern from the read cadence (see HR_PERIOD/HR_WIDTH). A polling
    // loop waiting for HR to assert must not hang.
    setReg(v, 15, 2);
    let sawSet = false, sawClear = false;
    for (let i = 0; i < 32; i++) {
      if (v.readStatus() & 0x20) sawSet = true; else sawClear = true;
    }
    expect(sawSet).toBe(true);
    expect(sawClear).toBe(true);
  });

  it('returns 0xFF for status registers above S9', () => {
    setReg(v, 15, 15);
    expect(v.readStatus()).toBe(0xFF);
  });

  it('reports the documented unused high bits in S4 and S6 after reset', () => {
    setReg(v, 15, 4);
    expect(v.readStatus()).toBe(0xFE);
    setReg(v, 15, 6);
    expect(v.readStatus()).toBe(0xFC);
  });

  it('selects the status register via R15', () => {
    v.endActiveDisplay();                  // S0 F set
    setReg(v, 15, 2);                      // read S2 instead
    expect(v.readStatus() & 0x80).toBe(0);
    setReg(v, 15, 0);
    expect(v.readStatus() & 0x80).toBe(0x80);
  });

  it('raises FH at the right border of the R19 line (one advanceScanline call later), and clears it when S1 is read', () => {
    // FH fires once line R19 has finished (its right border), not at its
    // start — since advanceScanline(line) runs before that line's own
    // cycles, the "line has finished" call is advanceScanline(line + 1).
    setReg(v, 0, 0x10);                    // IE0
    setReg(v, 19, 37);
    v.advanceScanline(37);
    expect(v.interruptPending()).toBe(false);
    v.advanceScanline(38);
    expect(v.interruptPending()).toBe(true);
    setReg(v, 15, 1);
    expect(v.readStatus() & 1).toBe(1);
    expect(v.interruptPending()).toBe(false);
  });

  it('includes R23 in the line-interrupt comparison', () => {
    setReg(v, 0, 0x10);
    setReg(v, 19, 12);
    setReg(v, 23, 3);
    v.advanceScanline(10);
    expect(v.interruptPending()).toBe(true);
  });
});

describe('V9938 mode decode and geometry', () => {
  let v: V9938;
  beforeEach(() => { v = new V9938(); v.reset(); });

  it('decodes the M1–M5 mode table', () => {
    expect(v.mode()).toBe('graphic1');                       // all clear
    setReg(v, 1, 0x10); expect(v.mode()).toBe('text1');      // M1
    setReg(v, 1, 0x10); setReg(v, 0, 0x04);
    expect(v.mode()).toBe('text2');                          // M1 + M4
    setReg(v, 0, 0x00); setReg(v, 1, 0x08);
    expect(v.mode()).toBe('multicolor');                     // M2
    setReg(v, 1, 0x00); setReg(v, 0, 0x02);
    expect(v.mode()).toBe('graphic2');                       // M3
    setReg(v, 0, 0x04); expect(v.mode()).toBe('graphic3');   // M4
    setReg(v, 0, 0x06); expect(v.mode()).toBe('graphic4');   // M3 + M4
    setReg(v, 0, 0x0A); expect(v.mode()).toBe('graphic6');   // M3 + M5
    setReg(v, 0, 0x0E); expect(v.mode()).toBe('graphic7');   // M3 + M4 + M5
  });

  it('offers 192 or 212 active lines via R9 LN', () => {
    expect(v.visibleHeight).toBe(192);
    setReg(v, 9, 0x80);
    expect(v.visibleHeight).toBe(212);
  });

  it('starts with the data-book power-up palette', () => {
    expect(v.pens[15]).toBe(0xFFFFFFFF);   // white
    expect(v.pens[0]).toBe(0xFF000000);    // black (shown as backdrop)
  });
});

describe('V9938 text-mode rendering', () => {
  let v: V9938;
  let line: Uint32Array;
  beforeEach(() => {
    v = new V9938();
    v.reset();
    line = new Uint32Array(V9938_WIDTH);
  });

  /** Name/pattern tables at 0; write a character code + all-set pattern. */
  function primeCell(code: number, pattern: number): void {
    v.vram[0] = code;                        // name table entry (row 0, col 0)
    v.vram[code * 8] = pattern;              // pattern row 0
  }

  it('renders a Text 2 cell as 6 fg/bg pixels after a 16-px margin', () => {
    setReg(v, 1, 0x50);                      // BL + M1
    setReg(v, 0, 0x04);                      // M4 → Text 2
    setReg(v, 7, 0xF0);                      // fg white, bg black
    primeCell(0x41, 0xFF);
    v.renderScanline(line, 0, 0);
    expect(line[15]).toBe(0xFF000000);       // margin = backdrop (bg of R7)
    expect(line[16]).toBe(0xFFFFFFFF);       // bit 0 set → fg
    expect(line[21]).toBe(0xFFFFFFFF);       // bit 5 set → fg
    expect(line[22]).toBe(0xFF000000);       // bit 6 clear → bg
  });

  it('renders a Text 1 cell double-width', () => {
    setReg(v, 1, 0x50);                      // BL + M1 → Text 1
    setReg(v, 7, 0xF0);
    primeCell(0x41, 0xC0);                   // only bits 0–1 set
    v.renderScanline(line, 0, 0);
    expect(line[16]).toBe(0xFFFFFFFF);
    expect(line[17]).toBe(0xFFFFFFFF);       // doubled
    expect(line[19]).toBe(0xFFFFFFFF);       // bit 1 doubled
    expect(line[20]).toBe(0xFF000000);       // bit 2 clear → bg
  });

  it('swaps R7 for R12 colours on blink-table cells while blink is on', () => {
    setReg(v, 1, 0x50);
    setReg(v, 0, 0x04);                      // Text 2
    setReg(v, 7, 0xF0);                      // normal: white on black
    setReg(v, 12, 0x4F);                     // blink: blue on white
    setReg(v, 3, 0xF8);                      // colour table base 0x3E00
    setReg(v, 10, 0);
    setReg(v, 13, 0x10);                     // off-period 0 → blink pinned on
    primeCell(0x41, 0xFF);
    v.vram[0x3E00] = 0x80;                   // blink bit for cell 0
    v.endActiveDisplay();                    // advance blink state machine
    v.renderScanline(line, 0, 0);
    expect(line[16]).toBe(v.pens[4]);        // dark blue fg from R12
  });

  it('shows only the backdrop while the display is blanked', () => {
    setReg(v, 1, 0x10);                      // M1 but BL clear → blanked
    setReg(v, 0, 0x04);
    setReg(v, 7, 0x02);                      // backdrop green-ish
    primeCell(0x41, 0xFF);
    v.renderScanline(line, 0, 0);
    expect(line[30]).toBe(v.pens[2]);
  });

  it('shows the R7 backdrop, not pens[0], for a foreground colour index of 0', () => {
    setReg(v, 1, 0x50);
    setReg(v, 0, 0x04);                      // Text 2
    setReg(v, 7, 0x0F);                      // fg index 0, backdrop (bg) index 15
    primeCell(0x41, 0xFF);                   // all bits set -> all fg
    v.renderScanline(line, 0, 0);
    expect(line[16]).toBe(v.pens[15]);
  });

  it('shows literal pens[0] for a foreground colour index of 0 when TP is set', () => {
    setReg(v, 1, 0x50);
    setReg(v, 0, 0x04);
    setReg(v, 7, 0x0F);
    setReg(v, 8, 0x20);                      // TP set -> colour 0 is opaque
    primeCell(0x41, 0xFF);
    v.renderScanline(line, 0, 0);
    expect(line[16]).toBe(v.pens[0]);
  });

  it('shows the R7 backdrop for a blink-table foreground colour index of 0', () => {
    setReg(v, 1, 0x50);
    setReg(v, 0, 0x04);                      // Text 2
    setReg(v, 7, 0x05);                      // backdrop = pens[5]
    setReg(v, 12, 0x0A);                     // blink: fg index 0, bg index 10
    setReg(v, 3, 0xF8);
    setReg(v, 10, 0);
    setReg(v, 13, 0x10);                     // off-period 0 -> blink pinned on
    primeCell(0x41, 0xFF);                   // all bits set -> all blink-fg
    v.vram[0x3E00] = 0x80;                   // blink bit for cell 0
    v.endActiveDisplay();
    v.renderScanline(line, 0, 0);
    expect(line[16]).toBe(v.pens[5]);
  });
});

describe('V9938 TMS-compatible graphics rendering', () => {
  it('uses R23 as a positive source-line offset in Graphics 1', () => {
    const v = new V9938();
    v.reset();
    const line = new Uint32Array(V9938_WIDTH);

    setReg(v, 1, 0x40);              // display on, Graphics 1
    setReg(v, 3, 0x30);              // colour table at 0x0C00
    setReg(v, 4, 0x01);              // pattern table at 0x0800
    setReg(v, 23, 0x01);             // display source line 1 at output line 0
    v.vram[0x0000] = 1;              // first name-table cell uses pattern 1
    v.vram[0x0800 + 8 + 1] = 0x80;   // source line 1: leftmost pixel set
    v.vram[0x0C00] = 0xF1;           // pattern group 0: white on black

    v.renderScanline(line, 0, 0);
    expect(line[0]).toBe(v.pens[15]);
    expect(line[1]).toBe(v.pens[15]); // 256-pixel mode doubles horizontally
    expect(line[2]).toBe(v.pens[1]);
  });

  it('shows the R7 backdrop, not pens[0], for a Graphics 1 background colour index of 0', () => {
    const v = new V9938();
    v.reset();
    const line = new Uint32Array(V9938_WIDTH);

    setReg(v, 1, 0x40);              // display on, Graphics 1
    setReg(v, 3, 0x30);              // colour table at 0x0C00
    setReg(v, 4, 0x01);              // pattern table at 0x0800
    setReg(v, 7, 0x05);              // backdrop = pens[5]
    setReg(v, 23, 0x01);             // display source line 1 at output line 0
    v.vram[0x0000] = 1;              // first name-table cell uses pattern group 0
    v.vram[0x0800 + 8 + 1] = 0x00;   // source line 1: all bits clear -> all bg
    v.vram[0x0C00] = 0xF0;           // pattern group 0: fg=15, bg index 0

    v.renderScanline(line, 0, 0);
    expect(line[0]).toBe(v.pens[5]);
  });

  it('shows the R7 backdrop, not pens[0], for a Graphics 2 background colour index of 0', () => {
    const v = new V9938();
    v.reset();
    const line = new Uint32Array(V9938_WIDTH);

    setReg(v, 1, 0x40);              // display on
    setReg(v, 0, 0x02);              // Graphics 2 (M3)
    setReg(v, 3, 0xFF);              // colour table at 0x2000, full mask
    setReg(v, 4, 0x03);              // pattern table at 0, full mask
    setReg(v, 7, 0x05);              // backdrop = pens[5]
    v.vram[0x0000] = 1;              // name-table cell -> pattern/colour group 1
    v.vram[8] = 0x00;                // pattern byte: all bits clear -> all bg
    v.vram[0x2008] = 0xF0;           // colour byte: fg=15, bg index 0

    v.renderScanline(line, 0, 0);
    expect(line[0]).toBe(v.pens[5]);
  });
});

describe('V9938 bitmap rendering', () => {
  let v: V9938;
  let line: Uint32Array;
  beforeEach(() => {
    v = new V9938();
    v.reset();
    line = new Uint32Array(V9938_WIDTH);
    setReg(v, 1, 0x40);                    // display on
  });

  it('renders GRAPHIC 4 as 256 four-bit pixels doubled to 512', () => {
    setReg(v, 0, 0x06);
    v.vram[0] = 0xF1;
    v.renderScanline(line, 0, 0);
    expect(Array.from(line.slice(0, 4))).toEqual([
      v.pens[15], v.pens[15], v.pens[1], v.pens[1],
    ]);
  });

  it('renders GRAPHIC 5 as 512 two-bit pixels', () => {
    setReg(v, 0, 0x08);
    v.vram[0] = 0x1B;                     // 00,01,10,11
    v.renderScanline(line, 0, 0);
    expect(Array.from(line.slice(0, 4))).toEqual([
      v.pens[0], v.pens[1], v.pens[2], v.pens[3],
    ]);
  });

  it('uses the two-bank byte interleave in GRAPHIC 6', () => {
    setReg(v, 0, 0x0A);
    v.vram[0] = 0xF1;                     // logical byte 0
    v.vram[0x10000] = 0x23;               // logical byte 1
    v.renderScanline(line, 0, 0);
    expect(Array.from(line.slice(0, 4))).toEqual([
      v.pens[15], v.pens[1], v.pens[2], v.pens[3],
    ]);
  });

  it('decodes the GRAPHIC 7 fixed GGGRRRBB palette', () => {
    setReg(v, 0, 0x0E);
    v.vram[0] = 0x1C;                     // G=0, R=7, B=0
    v.renderScanline(line, 0, 0);
    expect(line[0]).toBe(0xFF0000FF);      // opaque red in ABGR
    expect(line[1]).toBe(0xFF0000FF);
  });

  it('GRAPHIC 5 colour index 0 shows the even/odd R7 backdrop half by X position', () => {
    setReg(v, 0, 0x08);                    // GRAPHIC 5
    setReg(v, 7, 0x09);                    // even backdrop = pens[2], odd = pens[1]
    v.vram[0] = 0x00;                      // all four 2-bit pixels = colour index 0
    v.renderScanline(line, 0, 0);
    expect(line[0]).toBe(v.pens[2]);       // even X -> (R7 >> 2) & 3
    expect(line[1]).toBe(v.pens[1]);       // odd X -> R7 & 3
    expect(line[2]).toBe(v.pens[2]);
    expect(line[3]).toBe(v.pens[1]);
  });

  it('applies R18 horizontal display adjustment and clips at the edge', () => {
    setReg(v, 0, 0x06);
    setReg(v, 18, 0x0F);                  // +1 character-clock position
    v.vram[0] = 0xF0;
    v.renderScanline(line, 0, 0);
    expect(line[0]).toBe(v.backdrop());
    expect(line[1]).toBe(v.backdrop());
    expect(line[2]).toBe(v.pens[15]);
  });
});

describe('V9938 sprite rendering', () => {
  it('renders mode-2 sprites and records a collision position', () => {
    const v = new V9938();
    v.reset();
    const line = new Uint32Array(V9938_WIDTH);
    setReg(v, 0, 0x06);                   // GRAPHIC 4 / sprite mode 2
    setReg(v, 1, 0x40);
    setReg(v, 5, 0x24);                   // colour 1000h, attributes 1200h
    setReg(v, 6, 0x01);                   // patterns at 0800h
    v.vram[0x1200] = 0xFF;                // sprite 0 starts on line 0
    v.vram[0x1201] = 0;
    v.vram[0x1202] = 0;
    v.vram[0x1204] = 0xFF;                // sprite 1, same position
    v.vram[0x1205] = 0;
    v.vram[0x1206] = 0;
    v.vram[0x1208] = 216;                 // end marker
    v.vram[0x1000] = 0x0F;
    v.vram[0x1010] = 0x04;
    v.vram[0x0800] = 0x80;

    v.renderScanline(line, 0, 0);
    expect(line[0]).toBe(v.pens[15]);      // lower sprite number wins
    setReg(v, 15, 0);
    expect(v.readStatus() & 0x20).toBe(0x20);
    setReg(v, 15, 3);
    expect(v.readStatus()).toBe(12);       // VDP timing-space X bias
    setReg(v, 15, 5);
    expect(v.readStatus()).toBe(8);        // VDP timing-space Y bias
  });
});

describe('V9938 command processor', () => {
  let v: V9938;
  beforeEach(() => {
    v = new V9938();
    v.reset();
    setReg(v, 0, 0x06);                   // GRAPHIC 4
  });

  function status2(): number {
    setReg(v, 15, 2);
    return v.readStatus();
  }

  it('executes HMMV in a bounded scanline slice and updates CE', () => {
    setReg(v, 36, 0); setReg(v, 37, 0);   // DX
    setReg(v, 38, 0); setReg(v, 39, 0);   // DY
    setReg(v, 40, 4); setReg(v, 41, 0);   // NX = 4 dots = 2 bytes
    setReg(v, 42, 1); setReg(v, 43, 0);   // NY
    setReg(v, 44, 0xA5);
    setReg(v, 46, 0xC0);                  // HMMV
    expect(status2() & 1).toBe(1);
    v.advanceScanline(0);
    expect(Array.from(v.vram.slice(0, 2))).toEqual([0xA5, 0xA5]);
    expect(status2() & 1).toBe(0);
  });

  it('performs logical PSET and POINT operations', () => {
    setReg(v, 36, 1); setReg(v, 38, 0);
    setReg(v, 44, 0x0C);
    setReg(v, 46, 0x50);                  // PSET
    expect(v.vram[0] & 0x0F).toBe(0x0C);

    setReg(v, 32, 1); setReg(v, 34, 0);
    setReg(v, 46, 0x40);                  // POINT
    setReg(v, 15, 7);
    expect(v.readStatus()).toBe(0x0C);
  });

  it('honours HMMC transfer-ready handshakes', () => {
    setReg(v, 40, 4); setReg(v, 42, 1);
    setReg(v, 46, 0xF0);
    expect(status2() & 0x81).toBe(0x81);   // TR + CE
    setReg(v, 44, 0x12);
    expect(status2() & 0x81).toBe(0x81);
    setReg(v, 44, 0x34);
    expect(Array.from(v.vram.slice(0, 2))).toEqual([0x12, 0x34]);
    expect(status2() & 0x81).toBe(0);
  });

  it('streams LMCM pixels through S7', () => {
    v.vram[0] = 0xAB;
    setReg(v, 40, 2); setReg(v, 42, 1);
    setReg(v, 46, 0xA0);
    expect(status2() & 0x81).toBe(0x81);
    setReg(v, 15, 7);
    expect(v.readStatus()).toBe(0x0A);
    expect(v.readStatus()).toBe(0x0B);
    expect(status2() & 0x81).toBe(0);
  });

  it('fills and copies rectangles with LMMV and LMMM', () => {
    setReg(v, 36, 0); setReg(v, 38, 0);
    setReg(v, 40, 2); setReg(v, 42, 2);
    setReg(v, 44, 5);
    setReg(v, 46, 0x80);                  // LMMV 2x2
    v.advanceScanline(0);
    expect(v.vram[0]).toBe(0x55);
    expect(v.vram[128]).toBe(0x55);

    setReg(v, 32, 0); setReg(v, 34, 0);
    setReg(v, 36, 4); setReg(v, 38, 2);
    setReg(v, 40, 2); setReg(v, 42, 2);
    setReg(v, 46, 0x90);                  // LMMM
    v.advanceScanline(1);
    expect(v.vram[2 * 128 + 2]).toBe(0x55);
    expect(v.vram[3 * 128 + 2]).toBe(0x55);
  });

  it('supports HMMM and YMMM byte copies', () => {
    v.vram[0] = 0x12;
    v.vram[1] = 0x34;
    setReg(v, 32, 0); setReg(v, 34, 0);
    setReg(v, 36, 4); setReg(v, 38, 1);
    setReg(v, 40, 4); setReg(v, 42, 1);
    setReg(v, 46, 0xD0);                  // HMMM: two packed bytes
    v.advanceScanline(0);
    expect(Array.from(v.vram.slice(130, 132))).toEqual([0x12, 0x34]);

    setReg(v, 34, 1);                     // SY
    setReg(v, 36, 4); setReg(v, 38, 2);   // DX/DY
    setReg(v, 42, 1);
    setReg(v, 46, 0xE0);                  // YMMM: DX to right border
    v.advanceScanline(1);
    expect(Array.from(v.vram.slice(258, 260))).toEqual([0x12, 0x34]);
  });

  it('draws LINE and reports SRCH boundary coordinates', () => {
    setReg(v, 36, 0); setReg(v, 38, 0);
    setReg(v, 40, 3); setReg(v, 42, 0);   // major 3, minor 0
    setReg(v, 44, 0x0E);
    setReg(v, 46, 0x70);                  // LINE, x-major
    v.advanceScanline(0);
    expect(Array.from(v.vram.slice(0, 2))).toEqual([0xEE, 0xEE]);

    v.vram[3] = 0x07;                     // colour 7 at x=7
    setReg(v, 32, 0); setReg(v, 34, 0);
    setReg(v, 44, 7);
    setReg(v, 45, 0);                     // right, search equal
    setReg(v, 46, 0x60);
    v.advanceScanline(1);
    expect(status2() & 0x10).toBe(0x10);   // BD
    setReg(v, 15, 8);
    expect(v.readStatus()).toBe(7);
  });

  it('uses expansion VRAM as a command source and destination', () => {
    setReg(v, 36, 0); setReg(v, 38, 0);
    setReg(v, 44, 9);
    setReg(v, 45, 0x20);                  // MXD
    setReg(v, 46, 0x50);                  // PSET
    expect(v.vram[0x20000]).toBe(0x90);

    setReg(v, 32, 0); setReg(v, 34, 0);
    setReg(v, 45, 0x10);                  // MXS
    setReg(v, 46, 0x40);                  // POINT
    setReg(v, 15, 7);
    expect(v.readStatus()).toBe(9);
  });
});
