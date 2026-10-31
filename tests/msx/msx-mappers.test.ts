/**
 * More cartridge mappers: ASCII 8 KB / 16 KB with SRAM, R-Type and Cross Blaim,
 * their detection, the mapper override, and SRAM persistence in a snapshot.
 *
 * Bank register addresses, SRAM select bits and writable windows follow the
 * MSX Wiki "MegaROM Mappers" page:
 *  - ASCII8 SRAM: Xanadu = bit 5 of a 256KB board (the first bit above the
 *    segment bits), Royal Blood/Wizardry = bit 7; SRAM writable at 8000h-BFFFh.
 *  - ASCII16 SRAM (Hydlide 2): bit 4 selects the 2KB SRAM; writable at
 *    8000h-BFFFh.
 *  - R-Type: ASCII16 with 4000h-7FFFh fixed to segment 0Fh; 384KB.
 *  - Cross Blaim: 64KB; 4000h-7FFFh is segment 0; a write to 4045h picks the
 *    segment at 8000h-BFFFh (initially 0).
 */
import { describe, it, expect } from 'vitest';
import { MsxMemory, guessMegaRomMapper } from '@/machines/msx/msx-memory.ts';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';

const K8 = 0x2000;

/** An image of `blocks` 8KB blocks, each filled with (block number + 1) & 0xFF. */
function image(blocks: number): Uint8Array {
  const rom = new Uint8Array(blocks * K8);
  for (let b = 0; b < blocks; b++) rom.fill((b + 1) & 0xFF, b * K8, (b + 1) * K8);
  return rom;
}

function board(rom: Uint8Array, mapper: Parameters<MsxMemory['insertCartridge']>[1]): MsxMemory {
  const mem = new MsxMemory();
  mem.reset();
  mem.setPrimarySlots(0x14);
  mem.insertCartridge(rom, mapper);
  return mem;
}

describe('ASCII8 with SRAM', () => {
  it('Xanadu-style (256KB): bit 5 maps the 8KB SRAM, writable only at 8000h-BFFFh', () => {
    const mem = board(image(32), 'ascii8-sram8');
    mem.writeByte(0x7000, 0x20);                  // SRAM into 8000h-9FFFh
    mem.writeByte(0x8010, 0xA5);
    expect(mem.readByte(0x8010)).toBe(0xA5);
    mem.writeByte(0x7000, 0x03);                  // ROM block 3
    expect(mem.readByte(0x8010)).toBe(4);
    mem.writeByte(0x7000, 0x20);                  // back: the byte survived
    expect(mem.readByte(0x8010)).toBe(0xA5);
    // Reads work in the lower windows too, but writes there are dropped.
    mem.writeByte(0x6000, 0x20);
    expect(mem.readByte(0x4010)).toBe(0xA5);
    mem.writeByte(0x4010, 0x11);
    expect(mem.readByte(0x4010)).toBe(0xA5);
  });

  it('is writable through the A000h window as well', () => {
    const mem = board(image(32), 'ascii8-sram8');
    mem.writeByte(0x7800, 0x20);
    mem.writeByte(0xA000, 0x42);
    mem.writeByte(0x7000, 0x20);
    expect(mem.readByte(0x8000)).toBe(0x42);      // the same 8KB chip
  });

  it('Wizardry-style: bit 7 selects the SRAM and bit 5 stays a ROM bank bit', () => {
    const mem = board(image(64), 'ascii8-sram8-b7');
    mem.writeByte(0x7000, 0x20);                  // bit 5 only: ROM block 32
    expect(mem.readByte(0x8000)).toBe(33);
    mem.writeByte(0x7000, 0x80);
    mem.writeByte(0x8000, 0x5C);
    mem.writeByte(0x7000, 0x00);
    expect(mem.readByte(0x8000)).toBe(1);
    mem.writeByte(0x7000, 0x80);
    expect(mem.readByte(0x8000)).toBe(0x5C);
  });

  it('32KB SRAM: the low two bank bits pick one of four 8KB blocks', () => {
    const mem = board(image(64), 'ascii8-sram32');
    for (let blk = 0; blk < 4; blk++) {
      mem.writeByte(0x7000, 0x40 | blk);          // 64 blocks: SRAM bit is 0x40
      mem.writeByte(0x8000, 0x10 + blk);
    }
    for (let blk = 0; blk < 4; blk++) {
      mem.writeByte(0x7000, 0x40 | blk);
      expect(mem.readByte(0x8000)).toBe(0x10 + blk);
    }
  });

  it('keeps its SRAM across a reset (battery backed) but starts on ROM bank 0', () => {
    const mem = board(image(32), 'ascii8-sram8');
    mem.writeByte(0x7000, 0x20);
    mem.writeByte(0x8123, 0x77);
    mem.reset();
    mem.setPrimarySlots(0x14);
    expect(mem.readByte(0x8000)).toBe(1);
    mem.writeByte(0x7000, 0x20);
    expect(mem.readByte(0x8123)).toBe(0x77);
  });
});

describe('ASCII16 with SRAM', () => {
  it('Hydlide 2: bit 4 maps the 2KB SRAM, mirrored through the 16KB window', () => {
    const mem = board(image(16), 'ascii16-sram2');
    mem.writeByte(0x7000, 0x10);
    mem.writeByte(0x8005, 0x99);
    expect(mem.readByte(0x8805)).toBe(0x99);      // 2KB repeats every 800h
    expect(mem.readByte(0xB805)).toBe(0x99);
    mem.writeByte(0x8806, 0x34);
    expect(mem.readByte(0x8006)).toBe(0x34);
    mem.writeByte(0x7000, 0x02);                  // ROM 16KB segment 2 = blocks 4,5
    expect(mem.readByte(0x8000)).toBe(5);
    expect(mem.readByte(0xA000)).toBe(6);
    mem.writeByte(0x7000, 0x10);
    expect(mem.readByte(0x8005)).toBe(0x99);
  });

  it('writes to SRAM are dropped at 4000h-7FFFh even when selected there', () => {
    const mem = board(image(16), 'ascii16-sram2');
    mem.writeByte(0x6000, 0x10);
    mem.writeByte(0x4000, 0x66);
    expect(mem.readByte(0x4000)).toBe(0);
  });

  it('plain ASCII16 has no SRAM: bit 4 is just a ROM bank bit', () => {
    const mem = board(image(64), 'ascii16');
    mem.writeByte(0x7000, 0x10);                  // segment 16 = blocks 32,33
    expect(mem.readByte(0x8000)).toBe(33);
    mem.writeByte(0x8000, 0x55);
    expect(mem.readByte(0x8000)).toBe(33);
  });
});

describe('R-Type', () => {
  /** 384KB = 48 blocks. */
  const rom = image(48);

  it('fixes 4000h-7FFFh to 16KB segment 0Fh (blocks 30 and 31)', () => {
    const mem = board(rom, 'rtype');
    expect(mem.readByte(0x4000)).toBe(31);
    expect(mem.readByte(0x6000)).toBe(32);
    mem.writeByte(0x6000, 0x03);                  // the ASCII16 register for this half does nothing
    expect(mem.readByte(0x4000)).toBe(31);
  });

  it('switches 8000h-BFFFh through 7000h; segments 10h-17h (bit 4) wrap into the last 128KB', () => {
    const mem = board(rom, 'rtype');
    expect(mem.readByte(0x8000)).toBe(1);         // power-on segment 0
    mem.writeByte(0x7000, 0x05);
    expect(mem.readByte(0x8000)).toBe(11);
    expect(mem.readByte(0xA000)).toBe(12);
    mem.writeByte(0x7000, 0x17);                  // segment 17h = blocks 46,47
    expect(mem.readByte(0x8000)).toBe(47);
    expect(mem.readByte(0xA000)).toBe(48);
    mem.writeByte(0x7000, 0x1F);                  // bits 3 ignored with bit 4 set: segment 17h again
    expect(mem.readByte(0x8000)).toBe(47);
  });

  it('is told apart by its 384KB size', () => {
    expect(guessMegaRomMapper(rom)).toBe('rtype');
    expect(board(rom, undefined).cartridgeMapper).toBe('rtype');
  });
});

describe('Cross Blaim', () => {
  /** 64KB, "AB" header, four 16KB segments filled with 0x10..0x13. */
  function cross(): Uint8Array {
    const rom = new Uint8Array(0x10000);
    for (let s = 0; s < 4; s++) rom.fill(0x10 + s, s * 0x4000, (s + 1) * 0x4000);
    rom[0] = 0x41; rom[1] = 0x42;
    return rom;
  }

  it('fixes segment 0 at 4000h-7FFFh and starts with segment 0 at 8000h-BFFFh', () => {
    const mem = board(cross(), 'crossblaim');
    expect(mem.readByte(0x4100)).toBe(0x10);
    expect(mem.readByte(0x8100)).toBe(0x10);
  });

  it('selects the 8000h segment by writing 4045h, using bits 0-1; 0 selects segment 1', () => {
    const mem = board(cross(), 'crossblaim');
    mem.writeByte(0x4045, 2);
    expect(mem.readByte(0x8000)).toBe(0x12);
    expect(mem.readByte(0xBFFF)).toBe(0x12);
    mem.writeByte(0x4045, 3);
    expect(mem.readByte(0x9000)).toBe(0x13);
    mem.writeByte(0x4045, 0);
    expect(mem.readByte(0x8000)).toBe(0x11);
    mem.writeByte(0x4045, 0xFE);                  // bits 0-1 = 2
    expect(mem.readByte(0x8000)).toBe(0x12);
    expect(mem.readByte(0x4100)).toBe(0x10);      // the fixed half never moves
  });

  it('ignores writes to other addresses', () => {
    const mem = board(cross(), 'crossblaim');
    mem.writeByte(0x4044, 3);
    mem.writeByte(0x4046, 3);
    mem.writeByte(0x8045, 3);
    expect(mem.readByte(0x8100)).toBe(0x10);
  });

  it('is detected from stores to 4045h in a 64KB image, by LD (nn),A or LD HL,nn / LD (HL),A', () => {
    const a = cross();
    a.set([0x3E, 0x02, 0x32, 0x45, 0x40], 0x100);
    expect(guessMegaRomMapper(a)).toBe('crossblaim');
    const b = cross();
    b.set([0x21, 0x45, 0x40, 0x77], 0x200);
    expect(guessMegaRomMapper(b)).toBe('crossblaim');
  });
});

describe('detection through LD HL,nn / LD (HL),A', () => {
  it('counts a bank-register store made through HL', () => {
    const rom = image(16);
    for (let i = 0; i < 6; i++) rom.set([0x21, 0x00, 0x90, 0x77], 0x100 + i * 8);   // Konami SCC 9000h
    expect(guessMegaRomMapper(rom)).toBe('konami-scc');
  });
});

describe('mapper override', () => {
  it('re-inserts the cartridge with the chosen mapper and power-cycles', () => {
    const m = new MsxMachine('hx-10', null);
    try {
      const rom = image(32);
      rom[0] = 0x41; rom[1] = 0x42;
      m.insertCartridge(rom, 'x.rom');
      expect(m.memory.cartridgeMapper).toBe('ascii8');            // no stores: the fallback
      m.setCartridgeMapper('ascii8-sram8');
      expect(m.memory.cartridgeMapper).toBe('ascii8-sram8');
      expect(m.cartridgeName).toBe('x.rom');
      m.setCartridgeMapper(null);                                   // back to the guess
      expect(m.memory.cartridgeMapper).toBe('ascii8');
    } finally { m.destroy(); }
  });
});

describe('SRAM and SCC in a .msxstate', () => {
  it('keeps the SRAM contents, the bank registers and the mapper', async () => {
    const src = new MsxMachine('hx-10', null);
    const dst = new MsxMachine('hx-10', null);
    try {
      src.insertCartridge(image(32), 'x.rom', 'ascii8-sram8');
      src.memory.setPrimarySlots(0x14);
      src.memory.writeByte(0x7000, 0x20);
      for (let i = 0; i < 16; i++) src.memory.writeByte(0x8000 + i, 0xC0 + i);
      src.memory.writeByte(0x6000, 7);
      const r = await dst.services.snapshots.apply(await src.services.snapshots.save('.msxstate'), 'x.msxstate');
      expect(r.ok, r.message).toBe(true);
      expect(dst.memory.cartridgeMapper).toBe('ascii8-sram8');
      for (let i = 0; i < 16; i++) expect(dst.memory.readByte(0x8000 + i)).toBe(0xC0 + i);
      expect(dst.memory.readByte(0x4000)).toBe(8);                  // bank 7
    } finally { src.destroy(); dst.destroy(); }
  });

  it('keeps the SCC: switched-in window, waveforms, registers and the running phase', async () => {
    const src = new MsxMachine('hx-10', null);
    const dst = new MsxMachine('hx-10', null);
    try {
      src.insertCartridge(image(16), 'scc.rom', 'konami-scc');
      src.memory.setPrimarySlots(0x14);
      src.memory.writeByte(0x9000, 0x3F);
      for (let i = 0; i < 32; i++) src.memory.writeByte(0x9800 + i, i < 16 ? 100 : 156);
      src.memory.writeByte(0x9880, 90);
      src.memory.writeByte(0x988A, 13);
      src.memory.writeByte(0x988F, 1);
      src.memory.cart.scc!.clocksPerSample = 3_579_545 / 44100;
      for (let i = 0; i < 300; i++) src.memory.cart.scc!.generateSampleMono();
      const r = await dst.services.snapshots.apply(await src.services.snapshots.save('.msxstate'), 'x.msxstate');
      expect(r.ok, r.message).toBe(true);
      dst.memory.setPrimarySlots(0x14);
      expect(dst.memory.cartridgeMapper).toBe('konami-scc');
      expect(dst.memory.readByte(0x9805)).toBe(100);                // window still switched in
      expect(dst.memory.readByte(0x9814)).toBe(156);
      const a = src.memory.cart.scc!, b = dst.memory.cart.scc!;
      b.clocksPerSample = a.clocksPerSample;
      for (let i = 0; i < 400; i++) expect(b.generateSampleMono()).toBe(a.generateSampleMono());
    } finally { src.destroy(); dst.destroy(); }
  });
});
