/**
 * AceMemory — the Jupiter Ace's 1KB-chip decode.
 *
 * Expected values are derived from the address map (MAME cantab/jupace.cpp):
 * each 1KB chip mirrors through its unconnected upper address bits, so the
 * offset inside a chip is always addr & 0x3FF:
 *
 *   0000-1FFF  ROM (8KB, two 4KB chips)
 *   2000-27FF  video RAM   (screen file 2400-26FF)
 *   2800-2FFF  char RAM    (128 glyphs × 8 rows)
 *   3000-3FFF  main RAM
 *   4000-FFFF  unpopulated expansion → open bus
 */

import { describe, it, expect } from 'vitest';
import { AceMemory } from '@/machines/jupiter-ace/ace-memory.ts';

function rom8k(): Uint8Array {
  const rom = new Uint8Array(0x2000);
  for (let i = 0; i < rom.length; i++) rom[i] = i & 0xFF;
  return rom;
}

describe('AceMemory — ROM', () => {
  it('maps the full 8KB ROM at 0x0000-0x1FFF', () => {
    const mem = new AceMemory();
    mem.loadROM(rom8k());
    expect(mem.readByte(0x0000)).toBe(0x00);
    expect(mem.readByte(0x1234)).toBe(0x34);
    expect(mem.readByte(0x1FFF)).toBe(0xFF);
  });

  it('drops writes to ROM', () => {
    const mem = new AceMemory();
    mem.loadROM(rom8k());
    mem.writeByte(0x0100, 0x42);
    expect(mem.readByte(0x0100)).toBe(0x00);
  });

  it('mirrors a 4KB single-chip dump into the second 4KB socket', () => {
    const mem = new AceMemory();
    const rom4k = new Uint8Array(0x1000);
    for (let i = 0; i < rom4k.length; i++) rom4k[i] = (i * 7) & 0xFF;
    mem.loadROM(rom4k);
    // Independent check: read at 0x1234 must equal 0x234's source value (0x234*7 & 0xFF).
    expect(mem.readByte(0x1234)).toBe((0x234 * 7) & 0xFF);
  });
});

describe('AceMemory — 1KB chip decode and mirrors', () => {
  it('video RAM: a write at 0x2442 reads back through the 0x2000 mirror', () => {
    const mem = new AceMemory();
    mem.writeByte(0x2442, 0xAB);
    expect(mem.readByte(0x2442)).toBe(0xAB);
    expect(mem.readByte(0x2042)).toBe(0xAB);
  });

  it('screen file spans 0x2400-0x26FF; 0x2700 is the tie-off cell, not screen', () => {
    const mem = new AceMemory();
    // 0x26FF is the last screen byte; 0x2700 is a distinct cell — and per the
    // hardware it is tied to read 0 regardless of writes.
    mem.writeByte(0x26FF, 0x11);
    mem.writeByte(0x2700, 0x22);
    expect(mem.readByte(0x26FF)).toBe(0x11);
    expect(mem.readByte(0x2700)).toBe(0);
    // The A10 mirror: 0x26FF mirrors at 0x22FF.
    expect(mem.readByte(0x22FF)).toBe(0x11);
  });

  it('char RAM: a write at 0x2C15 reads back through the 0x2800 mirror', () => {
    const mem = new AceMemory();
    mem.writeByte(0x2C15, 0x5A);
    expect(mem.readByte(0x2C15)).toBe(0x5A);
    expect(mem.readByte(0x2815)).toBe(0x5A);
  });

  it('main RAM: a write at 0x3C3F reads back through the 0x3000 mirror', () => {
    const mem = new AceMemory();
    mem.writeByte(0x3C3F, 0x77);
    expect(mem.readByte(0x3C3F)).toBe(0x77);
    expect(mem.readByte(0x303F)).toBe(0x77);
  });

  it('main RAM mirrors across its whole 4KB window (0x3FFF ↔ 0x3BFF)', () => {
    const mem = new AceMemory();
    mem.writeByte(0x3FFF, 0x99);
    expect(mem.readByte(0x3FFF)).toBe(0x99);
    expect(mem.readByte(0x3BFF)).toBe(0x99);
  });
});

describe('AceMemory — video chip quirks (jupiter-ace.co.uk memory map)', () => {
  it('address 0x2700 always reads 0, even after a write', () => {
    const mem = new AceMemory();
    mem.writeByte(0x2700, 0xFF);
    expect(mem.readByte(0x2700)).toBe(0);
    // The tie-off follows the chip, so the 0x2000 mirror reads 0 too.
    expect(mem.readByte(0x2300)).toBe(0);
  });

  it('the PAD RAM at 0x2701-0x27FF is ordinary read/write RAM', () => {
    const mem = new AceMemory();
    mem.writeByte(0x2701, 0x42);
    expect(mem.readByte(0x2701)).toBe(0x42);
    mem.writeByte(0x27FF, 0x24);
    expect(mem.readByte(0x27FF)).toBe(0x24);
  });
});

describe('AceMemory — RAM packs', () => {
  it('default: no pack fitted, 0x4000+ is open bus', () => {
    const mem = new AceMemory();
    expect(mem.ramPackKB).toBe(0);
    mem.writeByte(0x4000, 0x42);
    expect(mem.readByte(0x4000)).toBe(0xFF);
  });

  it('16K pack: RAM at 0x4000-0x7FFF, open bus above (RAMTOP 32768, 19K total)', () => {
    const mem = new AceMemory();
    mem.setRamPack(16);
    expect(mem.ramPackKB).toBe(16);
    mem.writeByte(0x4000, 0x11);
    mem.writeByte(0x7FFF, 0x22);
    expect(mem.readByte(0x4000)).toBe(0x11);
    expect(mem.readByte(0x7FFF)).toBe(0x22);
    // The 16K pack stops at 0x7FFF — writes above are dropped.
    mem.writeByte(0x8000, 0x33);
    expect(mem.readByte(0x8000)).toBe(0xFF);
  });

  it('48K pack: RAM across the whole 0x4000-0xFFFF window (51K total)', () => {
    const mem = new AceMemory();
    mem.setRamPack(48);
    expect(mem.ramPackKB).toBe(48);
    mem.writeByte(0x4000, 0x11);
    mem.writeByte(0x7FFF, 0x22);
    mem.writeByte(0x8000, 0x33);
    mem.writeByte(0xFFFF, 0x44);
    expect(mem.readByte(0x4000)).toBe(0x11);
    expect(mem.readByte(0x7FFF)).toBe(0x22);
    expect(mem.readByte(0x8000)).toBe(0x33);
    expect(mem.readByte(0xFFFF)).toBe(0x44);
  });

  it('setRamPack(0) removes the pack again', () => {
    const mem = new AceMemory();
    mem.setRamPack(48);
    mem.setRamPack(0);
    mem.writeByte(0x4000, 0x42);
    expect(mem.ramPackKB).toBe(0);
    expect(mem.readByte(0x4000)).toBe(0xFF);
  });

  it('reset() zeroes the pack but keeps it fitted', () => {
    const mem = new AceMemory();
    mem.setRamPack(16);
    mem.writeByte(0x4000, 0x42);
    mem.reset();
    expect(mem.ramPackKB).toBe(16);
    expect(mem.readByte(0x4000)).toBe(0x00);
  });

  it('re-fitting the pack already in place leaves its contents alone', () => {
    // The settings pump re-applies every machine setting on any pane change,
    // so this runs on each volume-slider step. A dictionary loaded from tape
    // grows from 0x3C51 up into the pack, and must survive.
    const mem = new AceMemory();
    mem.setRamPack(48);
    mem.writeByte(0x8000, 0x42);
    mem.setRamPack(48);
    expect(mem.readByte(0x8000)).toBe(0x42);
  });

  it('changing the pack size keeps whatever still fits', () => {
    const mem = new AceMemory();
    mem.setRamPack(16);
    mem.writeByte(0x4000, 0x42);
    mem.setRamPack(48);
    expect(mem.ramPackKB).toBe(48);
    expect(mem.readByte(0x4000)).toBe(0x42);
    // Shrinking drops what no longer fits, but keeps the rest.
    mem.writeByte(0x8000, 0x24);
    mem.setRamPack(16);
    expect(mem.readByte(0x4000)).toBe(0x42);
    expect(mem.readByte(0x8000)).toBe(0xFF);
  });

  it('snapshot() and ramSnapshot() include the pack when fitted', () => {
    const mem = new AceMemory();
    mem.setRamPack(16);
    mem.writeByte(0x4000, 0x42);
    expect(mem.snapshot()[0x4000]).toBe(0x42);
    const dump = mem.ramSnapshot();
    expect(dump.length).toBe(0xC00 + 0x4000);
    expect(dump[0xC00]).toBe(0x42);   // pack starts after the onboard 3KB
  });
});

describe('AceMemory — snapshot and reset', () => {
  it('snapshot() composes the decoded space: ROM, chips, open bus', () => {
    const mem = new AceMemory();
    const rom = rom8k();
    mem.loadROM(rom);
    mem.writeByte(0x2442, 0xAB);
    mem.writeByte(0x2C15, 0x5A);
    mem.writeByte(0x3C3F, 0x77);
    const snap = mem.snapshot();
    expect(snap.length).toBe(0x10000);
    expect(snap[0x0100]).toBe(rom[0x0100]);
    expect(snap[0x2442]).toBe(0xAB);
    expect(snap[0x2C15]).toBe(0x5A);
    expect(snap[0x3C3F]).toBe(0x77);
    expect(snap[0x4000]).toBe(0xFF);
  });

  it('reset() zeroes the three RAM chips but keeps the ROM', () => {
    const mem = new AceMemory();
    mem.loadROM(rom8k());
    mem.writeByte(0x2442, 0xAB);
    mem.writeByte(0x3C3F, 0x77);
    mem.reset();
    expect(mem.readByte(0x2442)).toBe(0x00);
    expect(mem.readByte(0x3C3F)).toBe(0x00);
    expect(mem.readByte(0x0100)).toBe(0x00);
  });

  it('getRamBank(0) is a live view of the main RAM chip', () => {
    const mem = new AceMemory();
    const bank = mem.getRamBank(0);
    mem.writeByte(0x3C10, 0x66);
    expect(bank[0x10]).toBe(0x66);
  });

  it('ramSnapshot() concatenates video RAM, char RAM and main RAM', () => {
    const mem = new AceMemory();
    mem.writeByte(0x2400, 0x01);
    mem.writeByte(0x2C00, 0x02);
    mem.writeByte(0x3C00, 0x03);
    const dump = mem.ramSnapshot();
    expect(dump.length).toBe(0xC00);
    expect(dump[0x000]).toBe(0x01);
    expect(dump[0x400]).toBe(0x02);
    expect(dump[0x800]).toBe(0x03);
  });
});
