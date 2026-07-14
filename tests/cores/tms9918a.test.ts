import { describe, it, expect, beforeEach } from 'vitest';
import { Tms9918a, TMS9918_PALETTE, VDP_WIDTH } from '@/cores/tms9918a.ts';

// Expectations below are derived from the TMS9918A datasheet / Sean Young's
// "TMS9918.txt", not from the implementation.

describe('TMS9918A CPU interface', () => {
  let vdp: Tms9918a;
  beforeEach(() => { vdp = new Tms9918a(); });

  it('writes a mode register via the two-byte control sequence', () => {
    // First byte = value, second byte = 0x80 | register number.
    vdp.writeControl(0x1F);
    vdp.writeControl(0x80 | 1);
    expect(vdp.regs[1]).toBe(0x1F);
    // A second, independent register write.
    vdp.writeControl(0xAB);
    vdp.writeControl(0x80 | 7);
    expect(vdp.regs[7]).toBe(0xAB);
  });

  it('sets the VRAM address for writing and auto-increments', () => {
    // 0x40 in the second byte = write setup; address = (second&0x3F)<<8 | first.
    vdp.writeControl(0x00);
    vdp.writeControl(0x40);
    vdp.writeData(0xAA);
    vdp.writeData(0xBB);
    expect(vdp.vram[0]).toBe(0xAA);
    expect(vdp.vram[1]).toBe(0xBB);
  });

  it('read setup prefetches, and data reads are one byte behind (read-ahead)', () => {
    vdp.vram[5] = 0x12;
    vdp.vram[6] = 0x34;
    // 0x00 in the second byte = read setup: prefetches vram[5], address -> 6.
    vdp.writeControl(0x05);
    vdp.writeControl(0x00);
    expect(vdp.readData()).toBe(0x12); // returns the prefetched byte
    expect(vdp.readData()).toBe(0x34); // then vram[6]
  });

  it('wraps the VRAM address at 14 bits (16KB)', () => {
    // Point at the last VRAM byte via a write setup.
    vdp.writeControl(0xFF);       // low
    vdp.writeControl(0x40 | 0x3F); // high (write) -> address 0x3FFF
    vdp.writeData(0x77);
    expect(vdp.vram[0x3FFF]).toBe(0x77);
    vdp.writeData(0x88);           // must wrap to 0x0000
    expect(vdp.vram[0]).toBe(0x88);
  });
});

describe('TMS9918A interrupt', () => {
  let vdp: Tms9918a;
  beforeEach(() => { vdp = new Tms9918a(); });

  it('asserts INT only when the frame flag and R1 IE bit are both set', () => {
    vdp.raiseFrameInterrupt();
    expect(vdp.interruptPending()).toBe(false); // IE (R1 bit5) not set
    vdp.regs[1] = 0x20;                           // enable interrupts
    expect(vdp.interruptPending()).toBe(true);
  });

  it('reading the status register clears the frame interrupt flag', () => {
    vdp.regs[1] = 0x20;
    vdp.raiseFrameInterrupt();
    const st = vdp.readStatus();
    expect(st & 0x80).toBe(0x80);                 // F was set in the read value
    expect(vdp.interruptPending()).toBe(false);   // ...but is now cleared
  });
});

describe('TMS9918A palette format', () => {
  it('packs RGB into the renderer ABGR word', () => {
    // Black (index 1) and white (index 15) pin down the byte order.
    expect(TMS9918_PALETTE[1] >>> 0).toBe(0xFF000000);
    expect(TMS9918_PALETTE[15] >>> 0).toBe(0xFFFFFFFF);
    // Medium green 0x21C842 -> A=FF, B=42, G=C8, R=21.
    expect(TMS9918_PALETTE[2] >>> 0).toBe(0xFF42C821);
  });
});

describe('TMS9918A Graphics I rendering', () => {
  let vdp: Tms9918a;
  let px: Uint32Array;
  beforeEach(() => {
    vdp = new Tms9918a();
    px = new Uint32Array(VDP_WIDTH);
    // Graphics I, display enabled: R1 = BLANK(0x40); M1/M2/M3 all 0.
    vdp.regs[1] = 0x40;
    vdp.regs[0] = 0x00;
    // Tables placed apart: pattern @0x0000, colour @0x0800, name @0x1000.
    vdp.regs[4] = 0x00;   // pattern base (R4&7)<<11 = 0
    vdp.regs[3] = 0x20;   // colour base R3<<6 = 0x0800
    vdp.regs[2] = 0x04;   // name base (R2&0x0F)<<10 = 0x1000
    vdp.regs[7] = 0x00;   // backdrop black
  });

  it('decodes a cell through pattern + colour tables', () => {
    // Cell 0 = pattern index 1. Pattern line 0 = 0b1010_0000.
    vdp.vram[0x1000] = 0x01;
    vdp.vram[0x0000 + 1 * 8 + 0] = 0xA0;
    // Colour byte for pattern group (name>>3)=0: fg=2 (green), bg=1 (black).
    vdp.vram[0x0800 + 0] = 0x21;

    vdp.renderScanline(px, 0, 0);
    expect(px[0]).toBe(vdp.palette[2]); // bit7 = 1 -> fg
    expect(px[1]).toBe(vdp.palette[1]); // bit6 = 0 -> bg
    expect(px[2]).toBe(vdp.palette[2]); // bit5 = 1 -> fg
    for (let i = 3; i < 8; i++) expect(px[i]).toBe(vdp.palette[1]); // bg
  });

  it('a blanked display shows only the backdrop', () => {
    vdp.regs[1] = 0x00;     // BLANK bit clear -> display off
    vdp.regs[7] = 0x04;     // backdrop = colour 4 (dark blue)
    vdp.vram[0x1000] = 0x01;
    vdp.vram[8] = 0xFF;
    vdp.renderScanline(px, 0, 0);
    for (let i = 0; i < VDP_WIDTH; i++) expect(px[i]).toBe(vdp.palette[4]);
  });
});

describe('TMS9918A Text mode rendering', () => {
  it('renders 6px cells with an 8px backdrop margin and R7 colours', () => {
    const vdp = new Tms9918a();
    const px = new Uint32Array(VDP_WIDTH);
    // Text mode: R1 = BLANK(0x40) | M1(0x10) = 0x50.
    vdp.regs[1] = 0x50;
    vdp.regs[2] = 0x04;      // name base 0x1000
    vdp.regs[4] = 0x00;      // pattern base 0
    vdp.regs[7] = 0xF1;      // fg = white (15), bg/backdrop = black (1)

    vdp.vram[0x1000] = 0x01;               // cell 0 -> pattern 1
    vdp.vram[0 + 1 * 8 + 0] = 0x80;        // line 0, only bit7 set

    vdp.renderScanline(px, 0, 0);
    for (let i = 0; i < 8; i++) expect(px[i]).toBe(vdp.palette[1]); // left margin
    expect(px[8]).toBe(vdp.palette[15]);   // first active pixel -> fg
    expect(px[9]).toBe(vdp.palette[1]);    // background pixel -> backdrop
  });
});
