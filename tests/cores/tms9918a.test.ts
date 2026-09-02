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

  it('updates the address low byte on the first control write, before the second byte arrives', () => {
    // Establish a base address with a non-zero high byte, then send only
    // the first byte of a new address write (no second byte). Real
    // hardware updates the address register's low byte immediately, so a
    // data access at this point combines the new low byte with the old
    // high byte, not the fully stale address.
    vdp.writeControl(0x00);
    vdp.writeControl(0x40 | 0x12);   // address 0x1200 (write intent)
    vdp.writeControl(0x34);          // first byte only of a new low address
    vdp.writeData(0xAB);
    expect(vdp.vram[0x1234]).toBe(0xAB);
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

describe('TMS9918A sprites', () => {
  let vdp: Tms9918a;
  let px: Uint32Array;
  beforeEach(() => {
    vdp = new Tms9918a();
    px = new Uint32Array(VDP_WIDTH);
    // Graphics I, display enabled: R1 = BLANK(0x40); 8x8, no magnification.
    vdp.regs[1] = 0x40;
    vdp.regs[0] = 0x00;
    vdp.regs[5] = 0x01;   // sprite attribute table @ 0x0080 — kept off the
                           // sprite pattern table (below) so a sprite's own
                           // attribute bytes can't alias its pattern data.
    vdp.regs[6] = 0x00;   // sprite pattern table @ 0x0000
    vdp.regs[3] = 0x80;   // Graphics I colour table @ 0x2000, deliberately
                           // isolated from every VRAM address these tests
                           // write: its bytes stay 0, so fg=bg=0 and the
                           // background layer never draws — sprites render
                           // onto a clean backdrop regardless of what the
                           // (untouched) name/pattern registers point at.
    vdp.regs[7] = 0x00;   // backdrop black
    // One shared 8x8 pattern (index 0), all bits set, at pattern table base.
    for (let line = 0; line < 8; line++) vdp.vram[line] = 0xFF;
  });

  const ATTR_BASE = 0x0080;

  /** Sprite attribute entry: Y is "one less than the display row"; 0xFF
   *  (wrapping to 0) puts the sprite's top row at y=0. */
  function setSprite(n: number, x: number, colour: number): void {
    const a = ATTR_BASE + n * 4;
    vdp.vram[a] = 0xFF;      // sy=0
    vdp.vram[a + 1] = x;
    vdp.vram[a + 2] = 0;     // pattern index 0
    vdp.vram[a + 3] = colour;
  }
  function terminate(n: number): void { vdp.vram[ATTR_BASE + n * 4] = 0xD0; }

  it('draws a single sprite at its attribute position and colour', () => {
    setSprite(0, 20, 2 /* green */);
    terminate(1);
    vdp.renderScanline(px, 0, 0);
    for (let i = 0; i < 8; i++) expect(px[20 + i]).toBe(vdp.palette[2]);
    expect(px[19]).toBe(vdp.palette[0]); // backdrop just outside the sprite
  });

  it('sprite 0 has display priority over higher-numbered, overlapping sprites', () => {
    setSprite(0, 10, 2 /* green */);
    setSprite(1, 10, 8 /* red — fully overlaps sprite 0 */);
    terminate(2);
    vdp.renderScanline(px, 0, 0);
    for (let i = 0; i < 8; i++) expect(px[10 + i]).toBe(vdp.palette[2]); // sprite 0 wins
  });

  it('lower-priority sprite still shows where it does not overlap a higher one', () => {
    setSprite(0, 10, 2 /* green, columns 10-17 */);
    setSprite(1, 14, 8 /* red, columns 14-21 — overlaps only 14-17 */);
    terminate(2);
    vdp.renderScanline(px, 0, 0);
    for (let i = 10; i < 14; i++) expect(px[i]).toBe(vdp.palette[2]);   // sprite 0 only
    for (let i = 14; i < 18; i++) expect(px[i]).toBe(vdp.palette[2]);   // overlap: sprite 0 wins
    for (let i = 18; i < 22; i++) expect(px[i]).toBe(vdp.palette[8]);   // sprite 1 only
  });

  it('sets the coincidence flag when two opaque sprites overlap', () => {
    setSprite(0, 10, 2);
    setSprite(1, 10, 8); // fully overlapping
    terminate(2);
    vdp.renderScanline(px, 0, 0);
    expect(vdp.readStatus() & 0x20).toBe(0x20);
  });

  it('does NOT set the coincidence flag when sprites do not overlap', () => {
    setSprite(0, 10, 2);
    setSprite(1, 100, 8); // far apart, no overlap
    terminate(2);
    vdp.renderScanline(px, 0, 0);
    expect(vdp.readStatus() & 0x20).toBe(0);
  });

  it('a transparent (colour 0) sprite neither draws nor triggers coincidence', () => {
    setSprite(0, 10, 0);  // transparent
    setSprite(1, 10, 8);  // opaque, same position
    terminate(2);
    vdp.renderScanline(px, 0, 0);
    for (let i = 0; i < 8; i++) expect(px[10 + i]).toBe(vdp.palette[8]); // only sprite 1 drawn
    expect(vdp.readStatus() & 0x20).toBe(0); // no collision — sprite 0 never drew a pixel
  });

  it('a 5th sprite on the same line sets the fifth-sprite status flag and number', () => {
    for (let n = 0; n < 5; n++) setSprite(n, n * 20, 2);
    terminate(5);
    vdp.renderScanline(px, 0, 0);
    const st = vdp.readStatus();
    expect(st & 0x40).toBe(0x40);
    expect(st & 0x1F).toBe(4); // number of the first sprite over the limit
  });

  it('a transparent sprite still counts toward the 4-per-line / 5th-sprite limit', () => {
    setSprite(0, 0, 0);   // transparent, still occupies a slot
    for (let n = 1; n < 5; n++) setSprite(n, n * 20, 2);
    terminate(5);
    vdp.renderScanline(px, 0, 0);
    expect(vdp.readStatus() & 0x40).toBe(0x40);
  });

  it('does not update 5S while F (frame flag) is still set and unread', () => {
    vdp.raiseFrameInterrupt(); // F set, as if the previous frame's vblank was never polled
    for (let n = 0; n < 5; n++) setSprite(n, n * 20, 2);
    terminate(5);
    vdp.renderScanline(px, 0, 0);
    expect(vdp.readStatus() & 0x40).toBe(0); // 5S inhibited while F was set
  });

  it('updates 5S normally once F has been cleared by a status read', () => {
    vdp.raiseFrameInterrupt();
    vdp.readStatus(); // clears F
    for (let n = 0; n < 5; n++) setSprite(n, n * 20, 2);
    terminate(5);
    vdp.renderScanline(px, 0, 0);
    expect(vdp.readStatus() & 0x40).toBe(0x40);
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
