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
});
