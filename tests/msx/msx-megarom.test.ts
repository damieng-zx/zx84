/**
 * MSX mega-ROM mappers and mapper detection.
 *
 * Bank register addresses and power-on banking follow the openMSX mapper
 * sources (RomAscii8kB, RomAscii16kB, RomKonami, RomKonamiSCC) and the MSX
 * Assembly Page / MSX wiki mapper descriptions; the detection counts follow
 * openMSX's RomFactory `LD (nnnn),A` heuristic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MsxMemory, guessMegaRomMapper, isMegaRom } from '@/machines/msx/msx-memory.ts';

const K8 = 0x2000;

/** A 128KB image whose every 8KB block starts with its own block number. */
function megaRom(blocks = 16): Uint8Array {
  const rom = new Uint8Array(blocks * K8);
  for (let b = 0; b < blocks; b++) rom[b * K8] = b;
  return rom;
}

/** Plant `n` copies of `LD (addr),A` in the image. */
function plantStores(rom: Uint8Array, addr: number, n: number, at: number): number {
  for (let i = 0; i < n; i++) {
    rom[at++] = 0x32; rom[at++] = addr & 0xFF; rom[at++] = addr >> 8;
  }
  return at;
}

describe('MSX mega-ROM mappers', () => {
  let mem: MsxMemory;
  beforeEach(() => {
    mem = new MsxMemory();
    mem.reset();
    mem.setPrimarySlots(0x14);   // pages 1–2 → slot 1 (the cartridge)
  });
  const blockAt = (addr: number) => mem.readByte(addr);

  it('ASCII8: four 8KB banks switched through 0x6000/0x6800/0x7000/0x7800', () => {
    mem.insertCartridge(megaRom(), 'ascii8');
    mem.setPrimarySlots(0x14);
    expect([blockAt(0x4000), blockAt(0x6000), blockAt(0x8000), blockAt(0xA000)])
      .toEqual([0, 0, 0, 0]);                   // all banks 0 at power-on
    mem.writeByte(0x6000, 5);
    mem.writeByte(0x6800, 6);
    mem.writeByte(0x7000, 7);
    mem.writeByte(0x7FFF, 8);                   // anywhere in the 2KB window
    expect([blockAt(0x4000), blockAt(0x6000), blockAt(0x8000), blockAt(0xA000)])
      .toEqual([5, 6, 7, 8]);
  });

  it('ASCII8: masks the bank number to the ROM size', () => {
    mem.insertCartridge(megaRom(16), 'ascii8');
    mem.setPrimarySlots(0x14);
    mem.writeByte(0x6000, 16 + 3);              // 16 blocks → mask 0x0F
    expect(blockAt(0x4000)).toBe(3);
  });

  it('ASCII16: 16KB banks at 0x4000 (0x6000–0x67FF) and 0x8000 (0x7000–0x77FF)', () => {
    mem.insertCartridge(megaRom(), 'ascii16');
    mem.setPrimarySlots(0x14);
    mem.writeByte(0x6000, 2);                   // 16KB bank 2 = 8KB blocks 4,5
    mem.writeByte(0x77FF, 3);                   // 16KB bank 3 = blocks 6,7
    expect([blockAt(0x4000), blockAt(0x6000), blockAt(0x8000), blockAt(0xA000)])
      .toEqual([4, 5, 6, 7]);
    mem.writeByte(0x6800, 1);                   // 0x6800–0x6FFF is not a register
    expect(blockAt(0x4000)).toBe(4);
  });

  it('Konami: 0x4000 fixed to bank 0, 0x6000/0x8000/0xA000 switchable', () => {
    mem.insertCartridge(megaRom(), 'konami');
    mem.setPrimarySlots(0x14);
    expect([blockAt(0x4000), blockAt(0x6000), blockAt(0x8000), blockAt(0xA000)])
      .toEqual([0, 1, 2, 3]);
    mem.writeByte(0x4000, 9);                   // fixed bank: ignored
    mem.writeByte(0x6000, 10);
    mem.writeByte(0x8000, 11);
    mem.writeByte(0xA000, 12);
    expect([blockAt(0x4000), blockAt(0x6000), blockAt(0x8000), blockAt(0xA000)])
      .toEqual([0, 10, 11, 12]);
  });

  it('Konami SCC: banks switched through 0x5000/0x7000/0x9000/0xB000', () => {
    mem.insertCartridge(megaRom(), 'konami-scc');
    mem.setPrimarySlots(0x14);
    expect([blockAt(0x4000), blockAt(0x6000), blockAt(0x8000), blockAt(0xA000)])
      .toEqual([0, 1, 2, 3]);
    mem.writeByte(0x5000, 4);
    mem.writeByte(0x7000, 5);
    mem.writeByte(0x9000, 6);
    mem.writeByte(0xB7FF, 7);
    expect([blockAt(0x4000), blockAt(0x6000), blockAt(0x8000), blockAt(0xA000)])
      .toEqual([4, 5, 6, 7]);
    mem.writeByte(0x6000, 1);                   // plain Konami address: ignored
    expect(blockAt(0x6000)).toBe(5);
  });

  it('leaves pages 0 and 3 of a mega-ROM unmapped', () => {
    mem.insertCartridge(megaRom(), 'konami');
    mem.setPrimarySlots(0x55);                  // every page → slot 1
    expect(mem.readByte(0x0000)).toBe(0xFF);
    expect(mem.readByte(0xC000)).toBe(0xFF);
  });

  it('ignores bank writes while slot 1 is not selected there', () => {
    mem.insertCartridge(megaRom(), 'konami');
    mem.setPrimarySlots(0xA4);                  // page 1 → cart, pages 2–3 → RAM
    mem.writeByte(0x8000, 11);                  // lands in RAM, not the mapper
    mem.setPrimarySlots(0x14);
    expect(blockAt(0x8000)).toBe(2);
  });

  it('restores power-on banking on reset', () => {
    mem.insertCartridge(megaRom(), 'konami');
    mem.setPrimarySlots(0x14);
    mem.writeByte(0x6000, 10);
    mem.reset();
    mem.setPrimarySlots(0x14);
    expect(blockAt(0x6000)).toBe(1);
  });
});

describe('MSX mega-ROM detection', () => {
  it('treats >64KB images, and 64KB images headed "AB", as mega-ROMs', () => {
    expect(isMegaRom(new Uint8Array(0x20000))).toBe(true);
    expect(isMegaRom(new Uint8Array(0x10000))).toBe(false);
    const headed = new Uint8Array(0x10000);
    headed[0] = 0x41; headed[1] = 0x42;
    expect(isMegaRom(headed)).toBe(true);
    expect(isMegaRom(new Uint8Array(0xC000))).toBe(false);
  });

  it('picks Konami SCC from stores to 0x9000/0xB000', () => {
    const rom = megaRom();
    let at = 0x100;
    at = plantStores(rom, 0x9000, 3, at);
    plantStores(rom, 0xB000, 3, at);
    expect(guessMegaRomMapper(rom)).toBe('konami-scc');
  });

  it('picks Konami from stores to 0x8000/0xA000', () => {
    const rom = megaRom();
    let at = 0x100;
    at = plantStores(rom, 0x8000, 3, at);
    plantStores(rom, 0xA000, 3, at);
    expect(guessMegaRomMapper(rom)).toBe('konami');
  });

  it('picks ASCII8 from stores to 0x6800/0x7800', () => {
    const rom = megaRom();
    let at = 0x100;
    at = plantStores(rom, 0x6800, 3, at);
    plantStores(rom, 0x7800, 3, at);
    expect(guessMegaRomMapper(rom)).toBe('ascii8');
  });

  it('picks ASCII16 from stores to 0x6000/0x77FF', () => {
    const rom = megaRom();
    let at = 0x100;
    at = plantStores(rom, 0x6000, 3, at);
    plantStores(rom, 0x77FF, 3, at);
    expect(guessMegaRomMapper(rom)).toBe('ascii16');
  });

  it('applies the guessed mapper on insert', () => {
    const rom = megaRom();
    plantStores(rom, 0x9000, 4, 0x100);
    const mem = new MsxMemory();
    mem.insertCartridge(rom);
    expect(mem.cartridgeMapper).toBe('konami-scc');
  });
});
