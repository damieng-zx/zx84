/**
 * MsxMemory — primary-slot paging (Toshiba HX-10).
 *
 * Expectations are derived from the MSX slot model, not from the implementation:
 * PPI port A holds a 2-bit slot selector per 16KB page ([1:0]=page0 … [7:6]=
 * page3). On the HX-10, slot 0 = 32KB ROM (pages 0–1, read-only; pages 2–3
 * empty), slot 3 = 64KB RAM, slots 1/2 = empty (read 0xFF).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MsxMemory } from '@/msx/msx-memory.ts';

/** A 32KB ROM with a distinct marker at the start of each 16KB page. */
function makeRom(): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom[0x0000] = 0x42;           // page 0 marker
  rom[0x3FFF] = 0x24;           // page 0 last byte
  rom[0x4000] = 0x99;           // page 1 marker
  rom[0x7FFF] = 0x11;           // page 1 last byte
  return rom;
}

describe('MsxMemory slot paging', () => {
  let mem: MsxMemory;
  beforeEach(() => {
    mem = new MsxMemory();
    mem.loadROM(makeRom());
    mem.reset();               // primarySlot = 0: all pages → slot 0
  });

  it('maps ROM into pages 0–1 and leaves pages 2–3 empty at reset (slot 0)', () => {
    expect(mem.getPrimarySlot()).toBe(0x00);
    expect(mem.readByte(0x0000)).toBe(0x42);
    expect(mem.readByte(0x3FFF)).toBe(0x24);
    expect(mem.readByte(0x4000)).toBe(0x99);
    expect(mem.readByte(0x7FFF)).toBe(0x11);
    // Slot 0 pages 2–3 are unpopulated → 0xFF.
    expect(mem.readByte(0x8000)).toBe(0xFF);
    expect(mem.readByte(0xFFFF)).toBe(0xFF);
  });

  it('drops writes to a ROM page (slot 0)', () => {
    mem.writeByte(0x0000, 0x7E);
    expect(mem.readByte(0x0000)).toBe(0x42);   // unchanged
  });

  it('pages RAM (slot 3) into pages 2–3 when port A = 0xF0', () => {
    // 0xF0 = 11_11_00_00: page3=slot3, page2=slot3, page1=slot0, page0=slot0.
    mem.setPrimarySlots(0xF0);
    expect(mem.readByte(0x0000)).toBe(0x42);    // page 0 still ROM
    expect(mem.readByte(0x4000)).toBe(0x99);    // page 1 still ROM
    mem.writeByte(0x8000, 0x5A);                // page 2 now RAM
    mem.writeByte(0xC000, 0xA5);                // page 3 now RAM
    expect(mem.readByte(0x8000)).toBe(0x5A);
    expect(mem.readByte(0xC000)).toBe(0xA5);
  });

  it('pages RAM into every page when port A = 0xFF, with flat RAM addressing', () => {
    mem.setPrimarySlots(0xFF);                  // all pages → slot 3 (RAM)
    mem.writeByte(0x0000, 0x01);
    mem.writeByte(0xC000, 0x02);
    expect(mem.readByte(0x0000)).toBe(0x01);
    expect(mem.readByte(0xC000)).toBe(0x02);
    // Slot-3 RAM is flat: CPU address == physical RAM offset.
    expect(mem.getRamBank(0)[0x0000]).toBe(0x01);
    expect(mem.getRamBank(3)[0x0000]).toBe(0x02);
  });

  it('reads 0xFF from an empty cartridge slot (slot 1)', () => {
    // page0 = slot 1 (bits [1:0] = 01).
    mem.setPrimarySlots(0x01);
    expect(mem.readByte(0x0000)).toBe(0xFF);
    mem.writeByte(0x0000, 0x33);               // dropped (nothing there)
    expect(mem.readByte(0x0000)).toBe(0xFF);
  });

  it('snapshot reflects the current paged view', () => {
    const snap = mem.snapshot();
    expect(snap[0x0000]).toBe(0x42);           // ROM
    expect(snap[0x4000]).toBe(0x99);           // ROM
    expect(snap[0x8000]).toBe(0xFF);           // empty slot-0 page
    expect(snap[0xFFFF]).toBe(0xFF);
  });

  it('reset clears RAM and returns all pages to slot 0', () => {
    mem.setPrimarySlots(0xFF);
    mem.writeByte(0x8000, 0xCD);
    mem.reset();
    expect(mem.getPrimarySlot()).toBe(0x00);
    expect(mem.readByte(0x0000)).toBe(0x42);   // ROM back in page 0
    mem.setPrimarySlots(0xFF);                  // expose RAM again
    expect(mem.readByte(0x8000)).toBe(0x00);   // RAM was zeroed
  });
});
