import { describe, expect, it } from 'vitest';
import { MtxMemory } from '@/machines/mtx/mtx-memory.ts';

describe('MTX memory', () => {
  it('maps the MTX500 32K into 0x8000-0xFFFF in ROM mode', () => {
    const memory = new MtxMemory('mtx500');
    memory.writeByte(0x4000, 0x11);
    memory.writeByte(0x8000, 0x22);
    memory.writeByte(0xC000, 0x33);

    expect(memory.readByte(0x4000)).toBe(0xFF);
    expect(memory.readByte(0x8000)).toBe(0x22);
    expect(memory.readByte(0xC000)).toBe(0x33);
    expect(memory.getRamBank(1)[0]).toBe(0x22);
    expect(memory.getRamBank(0)[0]).toBe(0x33);
  });

  it('maps the MTX512 48K working RAM plus its 16K common block', () => {
    const memory = new MtxMemory('mtx512');
    memory.writeByte(0x4000, 0x41);
    memory.writeByte(0x8000, 0x81);
    memory.writeByte(0xC000, 0xC1);

    expect(memory.getRamBank(2)[0]).toBe(0x41);
    expect(memory.getRamBank(1)[0]).toBe(0x81);
    expect(memory.getRamBank(0)[0]).toBe(0xC1);
  });

  it('keeps the common 16K block visible across RAM pages', () => {
    const memory = new MtxMemory('mtx512');
    memory.writeByte(0xC123, 0x5A);
    memory.setPageRegister(0x8F);

    expect(memory.readByte(0xC123)).toBe(0x5A);
  });

  it('switches the OS and paged ROMs out when RELCPM is set', () => {
    const memory = new MtxMemory('mtx512');
    const rom = new Uint8Array(0x6000);
    rom[0] = 0xF3;
    rom[0x2000] = 0xB0;
    rom[0x4000] = 0xA1;
    memory.loadRom(rom);

    expect(memory.readByte(0x0000)).toBe(0xF3);
    expect(memory.readByte(0x2000)).toBe(0xB0);
    memory.setPageRegister(0x10);
    expect(memory.readByte(0x2000)).toBe(0xA1);

    memory.setPageRegister(0x80);
    memory.writeByte(0x0000, 0x55);
    expect(memory.readByte(0x0000)).toBe(0x55);
    expect(memory.getRamBank(3)[0]).toBe(0x55);
  });

  it('uses independent bank pairs for successive ROM-mode RAM pages', () => {
    const memory = new MtxMemory('mtx512');
    memory.writeByte(0x8000, 0x10);
    memory.setPageRegister(0x01);
    expect(memory.readByte(0x8000)).toBe(0);
    memory.writeByte(0x8000, 0x31);
    memory.setPageRegister(0x00);

    expect(memory.readByte(0x8000)).toBe(0x10);
  });

  it('adds 512 KiB of independently paged RAM to an MTX512', () => {
    const memory = new MtxMemory('mtx512');
    memory.set512kRamExpansionEnabled(true);

    expect(memory.ramSizeBytes).toBe(576 * 1024);
    expect(memory.ramBanks).toHaveLength(36);

    memory.setPageRegister(0x8A);
    memory.writeByte(0x0000, 0x31);
    memory.writeByte(0x4000, 0x32);
    memory.writeByte(0x8000, 0x33);
    memory.writeByte(0xC000, 0xC0);

    expect(memory.getRamBank(31)[0]).toBe(0x31);
    expect(memory.getRamBank(32)[0]).toBe(0x32);
    expect(memory.getRamBank(33)[0]).toBe(0x33);
    expect(memory.getRamBank(0)[0]).toBe(0xC0);
  });

  it('leaves the firmware sizing hole on ROM-mode page 15', () => {
    const memory = new MtxMemory('mtx512');
    memory.set512kRamExpansionEnabled(true);
    memory.setPageRegister(0x0F);

    memory.writeByte(0x4000, 0x40);
    memory.writeByte(0x8000, 0x80);

    expect(memory.readByte(0x4000)).toBe(0xFF);
    expect(memory.readByte(0x8000)).toBe(0x80);
    expect(memory.getRamBank(31)[0]).toBe(0x80);
    expect(memory.getRamBank(32)[0]).toBe(0xE5);
  });

  it('removes expansion blocks while preserving motherboard RAM', () => {
    const memory = new MtxMemory('mtx512');
    memory.getRamBank(0)[0] = 0x64;
    memory.set512kRamExpansionEnabled(true);
    memory.getRamBank(4)[0] = 0xE5;

    memory.set512kRamExpansionEnabled(false);

    expect(memory.ramSizeBytes).toBe(64 * 1024);
    expect(memory.ramBanks).toHaveLength(4);
    expect(memory.getRamBank(0)[0]).toBe(0x64);
    expect(memory.getRamBank(4)[0]).toBe(0);
  });

  it('preserves the volatile CP/M RAM disc across resets', () => {
    const memory = new MtxMemory('mtx512');
    memory.set512kRamExpansionEnabled(true);
    expect(memory.getRamBank(4)[0]).toBe(0xE5);
    memory.getRamBank(4)[0] = 0x51;
    memory.getRamBank(0)[0] = 0x64;

    memory.reset();

    expect(memory.getRamBank(4)[0]).toBe(0x51);
    expect(memory.getRamBank(0)[0]).toBe(0);
  });

  it('maps the optional fourth firmware image into FDX ROM page 5', () => {
    const memory = new MtxMemory('mtx512');
    const rom = new Uint8Array(0x8000);
    rom[0x6000] = 0xD7;

    memory.loadRom(rom);
    memory.setPageRegister(0x50);

    expect(memory.readByte(0x2000)).toBe(0xD7);
  });

  it('maps the five-image CP/M pack into bootstrap page 4 and FDX page 5', () => {
    const memory = new MtxMemory('mtx512');
    const rom = new Uint8Array(0xA000);
    rom[0x6000] = 0xC4;
    rom[0x8000] = 0xD5;

    memory.loadRom(rom);
    memory.setPageRegister(0x40);
    expect(memory.readByte(0x2000)).toBe(0xFF);
    memory.setCpmBootstrapEnabled(true);
    expect(memory.readByte(0x2000)).toBe(0xC4);
    memory.setPageRegister(0x50);
    expect(memory.readByte(0x2000)).toBe(0xD5);
  });

  it('maps ROM-pack banks into ROM page 2 through the subpage latch', () => {
    const memory = new MtxMemory('mtx512');
    const pack = new Uint8Array(4 * 0x2000);
    for (let bank = 0; bank < 4; bank++) {
      pack.fill(0x40 + bank, bank * 0x2000, (bank + 1) * 0x2000);
    }
    memory.insertRomPack(pack);
    memory.setPageRegister(0x20);

    expect(memory.readByte(0x2000)).toBe(0x40);
    memory.writeByte(0x0123, 2);
    expect(memory.selectedRomSubpage).toBe(2);
    expect(memory.readByte(0x2000)).toBe(0x42);

    memory.writeByte(0x0123, 4);
    expect(memory.readByte(0x2000)).toBe(0xFF);
  });

  it('keeps a fitted ROM pack across reset and removes it on eject', () => {
    const memory = new MtxMemory('mtx512');
    memory.insertRomPack(new Uint8Array(0x2000).fill(0x5A));
    memory.setPageRegister(0x20);
    memory.writeByte(0, 7);

    memory.reset();
    memory.setPageRegister(0x20);
    expect(memory.selectedRomSubpage).toBe(0);
    expect(memory.readByte(0x2000)).toBe(0x5A);

    memory.ejectRomPack();
    expect(memory.readByte(0x2000)).toBe(0xFF);
  });

  it('rejects malformed and oversized ROM packs', () => {
    const memory = new MtxMemory('mtx512');

    expect(() => memory.insertRomPack(new Uint8Array(0x1FFF)))
      .toThrow(/1-16 complete 8 KiB banks/);
    expect(() => memory.insertRomPack(new Uint8Array(0x2001)))
      .toThrow(/1-16 complete 8 KiB banks/);
    expect(() => memory.insertRomPack(new Uint8Array(0x22000)))
      .toThrow(/1-16 complete 8 KiB banks/);
  });
});
