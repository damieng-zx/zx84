/**
 * The 256K RAM boards: the Hannes/Solder 64K banking at $FD16, and the CSORY
 * 16K window at $FD15. Both leave $0000-$0FFF on the main RAM and are set up
 * from the Plus/4 World hardware notes.
 */

import { describe, it, expect } from 'vitest';
import { Plus4Memory, type Plus4Expansion } from '@/machines/plus4/memory.ts';

function board(type: Plus4Expansion): Plus4Memory {
  const mem = new Plus4Memory('plus4');
  mem.setExpansion(type);
  return mem;
}

describe('the Hannes 256K expansion', () => {
  it('switches the 64K bank above $1000, and leaves the default bank fitted', () => {
    const mem = board('hannes');
    expect(mem.expansionBank, 'power-on bank 3').toBe(3);
    // Bank 0, switching above $1000.
    mem.writeByte(0xFD16, 0x00);
    mem.writeByte(0x1000, 0xAA);
    expect(mem.readByte(0x1000)).toBe(0xAA);
    // Bank 1 is separate RAM.
    mem.writeByte(0xFD16, 0x01);
    expect(mem.readByte(0x1000), 'not bank 0').not.toBe(0xAA);
    mem.writeByte(0x1000, 0xBB);
    expect(mem.readByte(0x1000)).toBe(0xBB);
    // Bank 3 is the main board's RAM, whatever the expansion holds.
    mem.writeByte(0xFD16, 0x03);
    expect(mem.readByte(0x1000)).not.toBe(0xBB);
  });

  it('keeps $1000-$3FFF on the main RAM with the $4000 switch bound', () => {
    const mem = board('hannes');
    mem.writeByte(0xFD16, 0x81);        // bank 1, switch above $4000
    mem.writeByte(0x1000, 0x11);
    mem.writeByte(0x4000, 0x22);
    expect(mem.readByte(0x1000)).toBe(0x11);
    expect(mem.readByte(0x4000)).toBe(0x22);
  });

  it('lets the TED follow the CPU bank only with $FD16 bit 6', () => {
    const mem = board('hannes');
    mem.writeByte(0xFD16, 0x01);        // bank 1, TED on the default bank
    mem.writeByte(0x1000, 0x33);
    expect(mem.readTedByte(0x1000), 'TED reads bank 3').not.toBe(0x33);
    mem.writeByte(0xFD16, 0x41);        // bank 1, TED follows
    expect(mem.readTedByte(0x1000)).toBe(0x33);
    expect(mem.readByte(0xFD16), 'the register reads back').toBe(0x41);
  });
});

describe('the CSORY 256K expansion', () => {
  it('shows a 16K block in the window $FD15 selects', () => {
    const mem = board('csory');
    mem.writeByte(0xFD16, 0x20);        // bits 4/5 = 10: the CSORY window
    mem.writeByte(0xFD15, (2 << 6) | 5); // window 2 ($8000), block 5
    mem.writeByte(0x8000, 0x99);
    expect(mem.readByte(0x8000)).toBe(0x99);
    // Another block in the same window is different RAM.
    mem.writeByte(0xFD15, (2 << 6) | 6);
    expect(mem.readByte(0x8000)).not.toBe(0x99);
    // Moving the window away leaves the main RAM at $8000.
    mem.writeByte(0xFD15, (1 << 6) | 5); // window 1 ($4000-$7FFF)
    expect(mem.readByte(0x8000)).not.toBe(0x99);
    expect(mem.readByte(0x4000)).toBe(0x99);
  });

  it('does not expose the window to the TED', () => {
    const mem = board('csory');
    mem.writeByte(0xFD16, 0x20);
    mem.writeByte(0xFD15, (2 << 6) | 5);
    mem.writeByte(0x8000, 0x99);
    expect(mem.readTedByte(0x8000), 'the TED keeps the default bank').not.toBe(0x99);
    expect(mem.readByte(0xFD15), '$FD15 is write-only').toBe(0xFF);
  });
});
