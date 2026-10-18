/**
 * MsxMemory secondary-slot expansion (the register at 0xFFFF).
 *
 * No shipped model enables it (HX-10, HB-55 and HB-55P have no sub-slots), so
 * these use a synthetic layout. Expectations follow the MSX slot model: the
 * expansion register is visible at 0xFFFF only while an expanded primary slot is
 * selected in page 3; writing it stores two bits per page choosing that page's
 * sub-slot; reading returns the stored value inverted; every expanded slot has its
 * own register; reset clears them.
 */
import { describe, it, expect } from 'vitest';
import { MsxMemory, type MsxMemoryLayout } from '@/machines/msx/msx-memory.ts';
import { createMsxConfig } from '@/machines/msx/config.ts';

/** HX-10-style map (ROM slot 0, cartridge slot 1, RAM slot 2) with slot 3 expanded:
 *  sub-slot 0 = the slot-3 native contents (empty here), 1 = RAM, 2 = cartridge, 3 = ROM. */
const layout: MsxMemoryLayout = {
  ramSlot: 2, ramFirstPage: 0, firmwarePage: null, expansions: { 3: [3, 2, 1, 0] },
};

function make(l: MsxMemoryLayout = layout): MsxMemory {
  const mem = new MsxMemory(l);
  const rom = new Uint8Array(0x8000);
  rom[0] = 0x42; rom[0x4000] = 0x99;
  mem.loadROM(rom);
  mem.reset();
  return mem;
}

describe('expansion register at 0xFFFF', () => {
  it('reads back the complement of what was written, while the expanded slot is in page 3', () => {
    const mem = make();
    mem.setPrimarySlots(0xC0);                       // page 3 = slot 3 (expanded)
    expect(mem.readByte(0xFFFF)).toBe(0xFF);         // reset value 0x00 reads as 0xFF
    mem.writeByte(0xFFFF, 0xE4);
    expect(mem.readByte(0xFFFF)).toBe(0x1B);
    expect(mem.peekByte(0xFFFF)).toBe(0x1B);
    expect(mem.getExpansionRegister(3)).toBe(0x1B);
    mem.writeByte(0xFFFF, 0x00);
    expect(mem.readByte(0xFFFF)).toBe(0xFF);
    mem.writeByte(0xFFFF, 0xFF);
    expect(mem.readByte(0xFFFF)).toBe(0x00);
  });

  it('treats 0xFFFF as plain memory when page 3 selects an unexpanded slot', () => {
    const mem = make();
    mem.setPrimarySlots(0x80);                       // page 3 = slot 2 (RAM, unexpanded)
    mem.writeByte(0xFFFF, 0x5A);
    expect(mem.readByte(0xFFFF)).toBe(0x5A);         // RAM, not a complement
    mem.setPrimarySlots(0xC0);
    expect(mem.readByte(0xFFFF)).toBe(0xFF);         // the register is still 0: the RAM write missed it
    mem.writeByte(0xFFFF, 0x01);                     // and a register write must not touch RAM
    mem.setPrimarySlots(0x80);
    expect(mem.readByte(0xFFFF)).toBe(0x5A);
  });

  it('selects a sub-slot independently per 16KB page', () => {
    const mem = make();
    mem.setPrimarySlots(0xFF);                       // every page = slot 3
    // page0 -> sub 3 (ROM), page1 -> sub 1 (RAM), page2 -> sub 0 (empty), page3 -> sub 1 (RAM)
    mem.writeByte(0xFFFF, (1 << 6) | (0 << 4) | (1 << 2) | 3);
    expect(mem.readByte(0x0000)).toBe(0x42);         // ROM page 0
    mem.writeByte(0x0000, 0x77);
    expect(mem.readByte(0x0000)).toBe(0x42);         // ROM stays read-only
    mem.writeByte(0x4000, 0xA5);
    expect(mem.readByte(0x4000)).toBe(0xA5);         // page 1 is RAM (the slot-2 contents)
    expect(mem.readByte(0x8000)).toBe(0xFF);         // sub-slot 0 = empty slot-3 contents
    mem.writeByte(0xC000, 0x3C);
    mem.writeByte(0xFFFE, 0x7E);                     // beneath the register, page 3 is ordinary RAM
    expect(mem.readByte(0xC000)).toBe(0x3C);
    expect(mem.readByte(0xFFFE)).toBe(0x7E);
    // Re-select page 1 -> ROM page 1: the same address now reads the ROM marker.
    mem.writeByte(0xFFFF, (1 << 6) | (0 << 4) | (3 << 2) | 3);
    expect(mem.readByte(0x4000)).toBe(0x99);
    // The RAM written through the expanded slot is the real slot-2 RAM.
    mem.setPrimarySlots(0xAA);
    expect(mem.readByte(0x4000)).toBe(0xA5);
    expect(mem.readByte(0xC000)).toBe(0x3C);
    expect(mem.readByte(0xFFFE)).toBe(0x7E);
  });

  it('shows the register, not the sub-slot data, at 0xFFFF — also in snapshots', () => {
    const mem = make();
    mem.setPrimarySlots(0xC0);
    mem.writeByte(0xFFFF, 0xC0);                     // page 3 -> sub-slot 3 (ROM)
    expect(mem.readByte(0xFFFF)).toBe(0x3F);
    expect(mem.snapshot()[0xFFFF]).toBe(0x3F);
  });

  it('keeps a register per expanded slot and clears them on reset', () => {
    const mem = make({ ...layout, expansions: { 2: [2, 2, 2, 2], 3: [3, 2, 1, 0] } });
    mem.setPrimarySlots(0xC0);
    mem.writeByte(0xFFFF, 0xAA);
    mem.setPrimarySlots(0x80);                       // slot 2 is expanded as well, with its own register
    expect(mem.readByte(0xFFFF)).toBe(0xFF);
    mem.writeByte(0xFFFF, 0x0F);
    expect(mem.readByte(0xFFFF)).toBe(0xF0);
    mem.setPrimarySlots(0xC0);
    expect(mem.readByte(0xFFFF)).toBe(0x55);         // slot 3's register is untouched
    mem.reset();
    mem.setPrimarySlots(0xC0);
    expect(mem.readByte(0xFFFF)).toBe(0xFF);
    mem.setPrimarySlots(0x80);
    expect(mem.readByte(0xFFFF)).toBe(0xFF);
  });

  it('is absent on every shipped layout', () => {
    for (const model of ['hx-10', 'hb-55', 'hb-55p'] as const) {
      const mem = new MsxMemory(createMsxConfig(model).layout);
      for (let s = 0; s < 4; s++) expect(mem.isExpanded(s)).toBe(false);
      mem.setPrimarySlots(0xC0);                     // slot 3 in page 3: the empty expansion connector
      mem.writeByte(0xFFFF, 0x12);
      expect(mem.readByte(0xFFFF)).toBe(0xFF);
    }
    const hb = new MsxMemory(createMsxConfig('hb-55').layout);
    hb.writeByte(0xFFFF, 0x12);                      // slot 0 page 3 is plain RAM on the HB-55
    expect(hb.readByte(0xFFFF)).toBe(0x12);
  });
});
