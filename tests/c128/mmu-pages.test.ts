/**
 * Page 0 and page 1 of the CPU and where the MMU's pointers send them, as the
 * VICE test programs show real machines doing it (`c128/c64modemmu` and
 * `c128/mmu/mmuswap`, run once against this code: all 40 pass). Each case is
 * one of their questions asked of the memory map directly.
 *
 * The pointers P0 and P1 swap a page with the page they name; the stack (P1)
 * wins over page 0; the common RAM arms come first; a swap back needs the
 * target to be RAM in the block the CPU is looking at; in C64 mode nothing
 * moves forward but the swap back stays; and page 0/1 never follow CR bit 6
 * until a pointer moves them (they are block 0's).
 */

import { describe, it, expect } from 'vitest';
import { C128Memory } from '@/machines/c128/memory.ts';

const CR = 0, MCR = 5, RCR = 6, P0L = 7, P0H = 8, P1L = 9, P1H = 10;

function mem(): C128Memory {
  const m = new C128Memory();
  m.ram.fill(0);
  m.basic64.fill(0xB6);
  m.kernal64.fill(0xE6);
  m.ioRead = () => 0x1D;
  return m;
}

/** A pointer pair: low byte, then the block in the high byte's bit 0. */
function point(m: C128Memory, p0: number, p0bank: number, p1: number, p1bank: number): void {
  m.mmu.write(P0H, p0bank); m.mmu.write(P0L, p0);
  m.mmu.write(P1H, p1bank); m.mmu.write(P1L, p1);
}

const BANK1 = 0x10000;

describe('pages 0 and 1 in C128 mode', () => {
  it('are block 0 whatever CR bit 6 says, until a pointer moves them', () => {
    const m = mem();
    m.ram[0x80] = 0x55; m.ram[BANK1 + 0x80] = 0xAA;
    m.ram[0x180] = 0x56; m.ram[BANK1 + 0x180] = 0xAB;
    m.mmu.write(CR, 0x40);
    expect(m.readByte(0x0080)).toBe(0x55);
    expect(m.readByte(0x0180)).toBe(0x56);
    m.writeByte(0x0090, 0x77);
    expect(m.ram[0x90], 'a write goes to block 0 too').toBe(0x77);
    expect(m.ram[BANK1 + 0x90]).toBe(0);
    m.mmu.write(RCR, 0x08);                      // top common RAM changes nothing for page 0
    expect(m.readByte(0x0080)).toBe(0x55);
  });

  it('swap with the page a pointer names: P0 to page $30 shows $3080 at $80 and the old $80 at $3080', () => {
    const m = mem();
    m.ram[0x80] = 0x11; m.ram[0x3080] = 0x22;
    point(m, 0x30, 0, 1, 0);
    expect(m.readByte(0x0080)).toBe(0x22);
    expect(m.readByte(0x3080)).toBe(0x11);
    m.writeByte(0x3080, 0x33);
    expect(m.ram[0x80]).toBe(0x33);
    expect(m.ram[0x3080], 'the page that moved is untouched').toBe(0x22);
  });

  it('send both pages to page 1 when P0 names it (page 0 is then out of reach)', () => {
    const m = mem();
    m.ram[0x20] = 0x01; m.ram[0x120] = 0x02;
    point(m, 1, 0, 1, 0);
    expect(m.readByte(0x0020)).toBe(0x02);
    expect(m.readByte(0x0120)).toBe(0x02);
  });

  it('give the stack the swap when both pointers name one page: $3020 reads page 1', () => {
    const m = mem();
    m.ram[0x20] = 0x33; m.ram[0x120] = 0x55; m.ram[0x3020] = 0x77;
    point(m, 0x30, 0, 0x30, 0);
    expect(m.readByte(0x0020)).toBe(0x77);
    expect(m.readByte(0x0120)).toBe(0x77);
    expect(m.readByte(0x3020)).toBe(0x55);
  });

  it('swap pages 0 and 1 with P0 = 1 and P1 = 0 (writes see it)', () => {
    const m = mem();
    m.ram[0x20] = 0xAA; m.ram[0x120] = 0x55;
    point(m, 1, 0, 0, 0);
    m.writeByte(0x0030, 0x99);
    m.writeByte(0x0130, 0x98);
    expect(m.ram[0x130]).toBe(0x99);
    expect(m.ram[0x30]).toBe(0x98);
  });

  it('keep the swap back to the block the CPU sees: a target in block 1 leaves block 0 alone', () => {
    const m = mem();
    m.ram[0x3080] = 0xAA; m.ram[BANK1 + 0x3080] = 0xBB; m.ram[BANK1 + 0x80] = 0x11;
    point(m, 0x30, 1, 1, 0);
    expect(m.readByte(0x3080), 'CPU in block 0').toBe(0xAA);
    m.mmu.write(CR, 0x40);
    expect(m.readByte(0x3080), 'CPU in block 1: the swap applies').toBe(0x11);
    expect(m.readByte(0x0080), 'and $80 is the block 1 page $30').toBe(0xBB);
  });

  it('swap back inside the shared RAM too, and the shared RAM holds pages 0 and 1 in block 0', () => {
    const m = mem();
    m.ram[0x80] = 0x11; m.ram[0x3080] = 0x22; m.ram[BANK1 + 0x80] = 0x88;
    m.mmu.write(RCR, 0x04);                      // 1K common at the bottom
    point(m, 0x30, 1, 1, 0);
    expect(m.readByte(0x0080), 'shared: block 0 whatever the pointer says').toBe(0x22);
    m.mmu.write(CR, 0x40);
    expect(m.readByte(0x3080), 'bank 1 page $30: the swap back reads page 0 of block 1').toBe(0x88);
  });

  it('do not swap an I/O or ROM page back', () => {
    const m = mem();
    m.ram[0x80] = 0x11;
    point(m, 0xD0, 0, 1, 0);
    expect(m.readByte(0xD080), 'I/O wins').toBe(0x1D);
    point(m, 0x40, 0, 1, 0);
    m.basicLo.fill(0xA1);
    expect(m.readByte(0x4080), 'the low BASIC ROM wins').toBe(0xA1);
  });

  it('leave the 8502 port at $00 and $01 alone, but not the Z80, which has none', () => {
    const m = mem();
    point(m, 0x20, 0, 1, 0);
    m.writeByte(0x0000, 0x2F);
    expect(m.portDdr, 'the 8502 write reached its port').toBe(0x2F);
    expect(m.ram[0x2000], 'and not the relocated page').toBe(0);
    m.mmu.write(CR, 0x80);                       // bank 2 = bank 0, with no BIOS in the way
    m.z80Write(0x0005, 0x66);
    expect(m.ram[0x2005], 'the Z80 write follows P0').toBe(0x66);
    m.z80Write(0x0000, 0x67);
    expect(m.ram[0x2000], 'even at address 0').toBe(0x67);
    expect(m.z80Read(0x0000)).toBe(0x67);
  });
});

describe('pages 0 and 1 in C64 mode', () => {
  /** Pointers set in C128 mode, then the switch (the registers are gone after it). */
  function m64(p0: number, p1: number, cr = 0): C128Memory {
    const m = mem();
    m.mmu.write(CR, cr);
    point(m, p0, 0, p1, 0);
    m.mmu.write(MCR, 0x40);
    m.writeByte(0x0000, 0x2F); m.writeByte(0x0001, 0x37);
    m.ram[0x20] = 0xAA; m.ram[0x120] = 0x55; m.ram[0x3020] = 0x33; m.ram[0x3080] = 0x44; m.ram[0x80] = 0x55;
    return m;
  }

  it('does not move page 0 or 1 forward', () => {
    const m = m64(0x30, 0x30);
    expect(m.readByte(0x0020)).toBe(0xAA);
    expect(m.readByte(0x0120)).toBe(0x55);
  });

  it('still swaps the target page back: $3080 reads page 0 when P0 = $30', () => {
    const m = m64(0x30, 1);
    expect(m.readByte(0x3080)).toBe(0x55);
    m.writeByte(0x3090, 0x66);
    expect(m.ram[0x90], 'a write to the target lands in page 0 (they alias)').toBe(0x66);
  });

  it('gives P1 the swap when both name a page: $3020 reads the stack', () => {
    const m = m64(0x30, 0x30);
    expect(m.readByte(0x3020)).toBe(0x55);
  });

  it('reads page 1 at page 0 when P1 = 0, and swaps the pair with P0 = 1', () => {
    const m = m64(0, 0);
    expect(m.readByte(0x0020), 'P1 = 0: page 0 reads page 1').toBe(0x55);
    const s = m64(1, 0);
    expect(s.readByte(0x0020)).toBe(0x55);
    expect(s.readByte(0x0120)).toBe(0xAA);
  });

  it('leaves ROM alone: BASIC at $A080 beats a P0 pointing there', () => {
    const m = m64(0xA0, 1);
    expect(m.readByte(0xA080)).toBe(0xB6);
  });

  it('follows CR bit 6 into C64 mode: the block it named holds page 0', () => {
    const m = mem();
    m.ram[0x80] = 0x55; m.ram[BANK1 + 0x80] = 0xAA;
    m.mmu.write(CR, 0x40);
    m.mmu.write(MCR, 0x40);
    expect(m.readByte(0x0080)).toBe(0xAA);
    m.mmu.write(RCR, 0x04);                      // common RAM at the bottom: block 0
    expect(m.readByte(0x0080)).toBe(0x55);
  });
});
