/**
 * The 128's memory map in C128 mode, from the Programmer's Reference Guide's
 * table of the configuration register: each region against each ROM-select
 * value, writes under ROM, the RAM blocks and the common RAM, relocated pages,
 * the load-configuration addresses seen from the CPU, the 8502 port's colour
 * RAM banks, the Z80's view (BIOS under bank 0, its IN and OUT), and the
 * VIC-IIe's window. The ROMs are marker bytes, so nothing here needs firmware.
 */

import { describe, it, expect } from 'vitest';
import { C128Memory } from '@/machines/c128/memory.ts';

const BASIC_LO = 0xA1, BASIC_HI = 0xB2, EDITOR = 0xC3, KERNAL = 0xE4, BIOS = 0xB5, CHARGEN128 = 0x28, CHARGEN64 = 0x64;

const CR = 0xFF00;

function mem(): C128Memory {
  const m = new C128Memory();
  m.ram.fill(0);                                 // not the power-on pattern: probes read 0
  m.basicLo.fill(BASIC_LO);
  m.basicHi.fill(BASIC_HI);
  m.kernal.fill(KERNAL);
  m.kernal.fill(EDITOR, 0, 0x1000);              // $C000-$CFFF
  m.kernal.fill(BIOS, 0x1000, 0x2000);           // under the I/O page: the Z80 BIOS
  m.chargen.fill(CHARGEN64, 0, 0x1000);
  m.chargen.fill(CHARGEN128, 0x1000);
  m.ioRead = (addr) => 0x10 | (addr & 0x0F);
  return m;
}

/** What the 8502 reads at each region's first address under a CR value. */
function view(m: C128Memory, cr: number): Record<string, number> {
  m.writeByte(CR, cr);
  return {
    lo: m.readByte(0x4000), hi: m.readByte(0x8000), editor: m.readByte(0xC000),
    d: m.readByte(0xD000), kernal: m.readByte(0xE000),
  };
}

describe('C128 memory: the configuration register', () => {
  it('puts the ROMs and the I/O page where CR 0 says: BASIC lo, BASIC hi, editor, I/O, KERNAL', () => {
    const m = mem();
    m.ram[0x4000] = 0x41; m.ram[0x8000] = 0x81; m.ram[0xC000] = 0xC1; m.ram[0xD000] = 0xD1; m.ram[0xE000] = 0xE1;
    expect(view(m, 0x00)).toEqual({ lo: BASIC_LO, hi: BASIC_HI, editor: EDITOR, d: 0x10, kernal: KERNAL });
  });

  it('bit 1 swaps $4000-$7FFF between the low BASIC ROM and RAM', () => {
    const m = mem();
    m.ram[0x4000] = 0x41;
    expect(view(m, 0x00).lo).toBe(BASIC_LO);
    expect(view(m, 0x02).lo).toBe(0x41);
  });

  it('bits 3-2 choose $8000-$BFFF: high BASIC, internal function ROM, external function ROM, RAM', () => {
    const m = mem();
    m.ram[0x8000] = 0x81;
    expect(view(m, 0x00).hi).toBe(BASIC_HI);
    expect(view(m, 0x04).hi, 'internal function ROM: nothing fitted').toBe(0xFF);
    expect(view(m, 0x08).hi, 'external function ROM: nothing fitted').toBe(0xFF);
    expect(view(m, 0x0C).hi).toBe(0x81);
  });

  it('bits 5-4 choose $C000-$FFFF: system ROM, internal function ROM, external function ROM, RAM', () => {
    const m = mem();
    m.ram[0xC000] = 0xC1; m.ram[0xE000] = 0xE1;
    expect(view(m, 0x00)).toMatchObject({ editor: EDITOR, kernal: KERNAL });
    expect(view(m, 0x10)).toMatchObject({ editor: 0xFF, kernal: 0xFF });
    expect(view(m, 0x20)).toMatchObject({ editor: 0xFF, kernal: 0xFF });
    expect(view(m, 0x30)).toMatchObject({ editor: 0xC1, kernal: 0xE1 });
  });

  it('bit 0 swaps $D000-$DFFF from I/O to what bits 5-4 choose, the character ROM under the system ROM', () => {
    const m = mem();
    m.ram[0xD000] = 0xD1;
    expect(view(m, 0x00).d, 'I/O').toBe(0x10);
    expect(view(m, 0x01).d, 'system ROM: the 128 character set').toBe(CHARGEN128);
    expect(view(m, 0x11).d, 'internal function ROM').toBe(0xFF);
    expect(view(m, 0x31).d, 'RAM').toBe(0xD1);
    expect(view(m, 0x30).d, 'bit 0 clear: I/O whatever bits 5-4 say').toBe(0x10);
  });

  it('keeps the first 16K as RAM whatever CR says', () => {
    const m = mem();
    m.ram[0x3FFF] = 0x3F;
    for (const cr of [0x00, 0x3F, 0x0E]) {
      view(m, cr);
      expect(m.readByte(0x3FFF), `CR ${cr}`).toBe(0x3F);
    }
  });
});

describe('C128 memory: writes', () => {
  it('reach the RAM under every ROM', () => {
    const m = mem();
    m.writeByte(CR, 0x01);
    for (const addr of [0x4000, 0x8000, 0xC000, 0xD000, 0xE000]) m.writeByte(addr, 0x5A);
    for (const addr of [0x4000, 0x8000, 0xC000, 0xD000, 0xE000]) expect(m.ram[addr], addr.toString(16)).toBe(0x5A);
    expect(m.readByte(0x4000), 'still reads the ROM').toBe(BASIC_LO);
  });

  it('go to I/O at $D000-$DFFF while CR bit 0 is 0, and to RAM when it is 1', () => {
    const m = mem();
    const seen: number[] = [];
    m.ioWrite = (addr) => { seen.push(addr); };
    m.writeByte(0xD020, 1);
    expect(seen).toEqual([0xD020]);
    expect(m.ram[0xD020]).toBe(0);
    m.writeByte(CR, 0x01);
    m.writeByte(0xD020, 2);
    expect(seen).toEqual([0xD020]);
    expect(m.ram[0xD020]).toBe(2);
  });
});

describe('C128 memory: RAM blocks and the common RAM', () => {
  it('CR bit 6 chooses which 64K block the CPU sees', () => {
    const m = mem();
    m.writeByte(0x2000, 0xA0);
    m.writeByte(CR, 0x40);
    expect(m.readByte(0x2000)).toBe(0x00);
    m.writeByte(0x2000, 0xB0);
    expect([m.ram[0x2000], m.ram[0x12000]]).toEqual([0xA0, 0xB0]);
    m.writeByte(CR, 0x00);
    expect(m.readByte(0x2000)).toBe(0xA0);
  });

  it('common RAM at the top is block 0 from the size down, at every size', () => {
    const sizes: [number, number][] = [[0, 0x400], [1, 0x1000], [2, 0x2000], [3, 0x4000]];
    for (const [bits, size] of sizes) {
      const m = mem();
      m.writeByte(CR, 0x71);                  // block 1, RAM at the top, I/O off (so $DFFF is RAM)
      m.mmu.write(6, 0x08 | bits);
      const first = 0x10000 - size;
      m.writeByte(first, 0x11);               // common: block 0
      m.writeByte(first - 1, 0x22);           // just below: block 1
      expect(m.ram[first], `$${first.toString(16)} at size ${size}`).toBe(0x11);
      expect(m.ram[0x10000 + first - 1], `just below at size ${size}`).toBe(0x22);
      expect(m.ram[first - 1], `block 0 untouched below at size ${size}`).toBe(0x00);
    }
  });

  it('common RAM at the bottom is block 0 up to the size, at every size', () => {
    const sizes: [number, number][] = [[0, 0x400], [1, 0x1000], [2, 0x2000], [3, 0x4000]];
    for (const [bits, size] of sizes) {
      const m = mem();
      m.writeByte(CR, 0x40);
      m.mmu.write(6, 0x04 | bits);
      m.writeByte(size - 1, 0x11);            // common: block 0
      m.writeByte(size, 0x22);                // just above: block 1
      expect(m.ram[size - 1], `last common byte at size ${size}`).toBe(0x11);
      expect(m.ram[0x10000 + size], `first banked byte at size ${size}`).toBe(0x22);
      expect(m.ram[size], `block 0 untouched above at size ${size}`).toBe(0x00);
    }
  });

  it('shows block 0 at $FFxx in common RAM while block 1 is selected', () => {
    const m = mem();
    m.writeByte(CR, 0x70);
    m.mmu.write(6, 0x0B);                     // 16K common at the top
    m.writeByte(0xFFD0, 0x77);
    expect(m.ram[0xFFD0]).toBe(0x77);
    expect(m.readByte(0xFFD0)).toBe(0x77);
    m.writeByte(CR, 0x00);
    m.writeByte(CR, 0x30);
    expect(m.readByte(0xFFD0)).toBe(0x77);
  });
});

describe('C128 memory: the MMU at $FF00', () => {
  it('reads CR and the preconfigurations at $FF00-$FF04 over whatever the top of memory holds', () => {
    const m = mem();
    m.mmu.write(1, 0x3F); m.mmu.write(2, 0x7F); m.mmu.write(3, 0x3E); m.mmu.write(4, 0x7E);
    m.writeByte(CR, 0x00);
    expect([0, 1, 2, 3, 4].map((n) => m.readByte(0xFF00 + n))).toEqual([0x00, 0x3F, 0x7F, 0x3E, 0x7E]);
    expect(m.readByte(0xFF05), 'above them: the system ROM').toBe(KERNAL);
  });

  it('loads a preconfiguration into CR on a write to $FF01-$FF04', () => {
    const m = mem();
    m.mmu.write(3, 0x3E);
    m.writeByte(0xFF03, 0x00);
    expect(m.mmu.cr).toBe(0x3E);
  });

  it('writes $FF05 and above to RAM, not to the MMU', () => {
    const m = mem();
    m.writeByte(0xFF05, 0x66);
    expect(m.ram[0xFF05]).toBe(0x66);
    expect(m.mmu.cr).toBe(0);
  });
});

describe('C128 memory: relocated pages', () => {
  it('reads and writes page 0 where P0 says, and the page P0 names where page 0 was', () => {
    const m = mem();
    m.ram[0x2005] = 0x25;
    m.ram[0x0005] = 0x05;
    m.mmu.write(7, 0x20);                     // P0L
    expect(m.readByte(0x0005)).toBe(0x25);
    expect(m.readByte(0x2005)).toBe(0x05);
    m.writeByte(0x0006, 0x99);
    expect(m.ram[0x2006]).toBe(0x99);
  });

  it('relocates page 1 the same way, for the stack', () => {
    const m = mem();
    m.ram[0x01F0] = 0x17;
    m.mmu.write(9, 0x30);                     // P1L
    m.writeByte(0x01F0, 0x42);
    expect(m.ram[0x30F0]).toBe(0x42);
    expect(m.readByte(0x30F0), 'the old page 1 shows where page 1 went').toBe(0x17);
  });

  it('never relocates the 8502 port', () => {
    const m = mem();
    m.mmu.write(7, 0x20);
    m.writeByte(0x0000, 0x2F);
    expect(m.portDdr).toBe(0x2F);
    expect(m.readByte(0x0000)).toBe(0x2F);
  });

  it('can send page 0 to the other RAM block', () => {
    const m = mem();
    m.mmu.write(8, 0x01); m.mmu.write(7, 0x10);
    m.writeByte(0x0003, 0x31);
    expect(m.ram[0x10000 + 0x1003]).toBe(0x31);
  });
});

describe('C128 memory: the 8502 port', () => {
  it('reads inputs high on bits 0-2 and 4 (no button down), 6 (CAPS LOCK up), and low on bits 3, 5, 7', () => {
    const m = mem();
    expect(m.readByte(1)).toBe(0x57);
  });

  it('reads bit 4 low with a Datasette button down and bit 6 low with CAPS LOCK down', () => {
    const m = mem();
    m.cassetteSense = true;
    expect(m.readByte(1) & 0x10).toBe(0);
    m.capsLockDown = true;
    expect(m.readByte(1) & 0x40).toBe(0);
  });

  it('reads back the latch on output bits', () => {
    const m = mem();
    m.writeByte(0, 0x2F);
    m.writeByte(1, 0x28);
    expect(m.readByte(1) & 0x2F).toBe(0x28);
    expect(m.motorOn, 'bit 5 driven high: motor off').toBe(false);
  });

  it('runs the Datasette motor while bit 5 is driven low', () => {
    const m = mem();
    m.writeByte(0, 0x20);
    m.writeByte(1, 0x00);
    expect(m.motorOn).toBe(true);
    m.writeByte(1, 0x20);
    expect(m.motorOn).toBe(false);
  });

  it('selects the colour RAM bank of the CPU by bit 0 and of the VIC-IIe by bit 1 (1 is bank 0)', () => {
    const m = mem();
    m.colorBanks[0].fill(0x01);
    m.colorBanks[1].fill(0x02);
    m.writeByte(0, 0x03);
    m.writeByte(1, 0x03);
    expect([m.colorRead(0), m.colorRam[0]]).toEqual([1, 1]);
    m.writeByte(1, 0x02);
    expect([m.colorRead(0), m.colorRam[0]]).toEqual([2, 1]);
    m.writeByte(1, 0x01);
    expect([m.colorRead(0), m.colorRam[0]]).toEqual([1, 2]);
    m.colorWrite(5, 0xFA);
    expect(m.colorBanks[0][5], 'only four bits are kept').toBe(0x0A);
  });

  it('calls the machine when the port changes', () => {
    const m = mem();
    let n = 0;
    m.onPortChange = () => { n++; };
    m.writeByte(0, 0x20);
    m.writeByte(1, 0x20);
    expect(n).toBe(2);
  });
});

describe('C128 memory: the Z80', () => {
  it('sees the BIOS at $0000-$0FFF while the RAM block is 0, and RAM when it is not', () => {
    const m = mem();
    m.ram[0x0100] = 0x77;
    expect(m.z80Read(0x0000)).toBe(BIOS);
    expect(m.z80Read(0x0FFF)).toBe(BIOS);
    m.mmu.write(0, 0x40);
    expect(m.z80Read(0x0800)).toBe(0x00);
    // Pages 0 and 1 are not the block CR names but where the pointers say (block 0 at power-on).
    expect(m.z80Read(0x0100)).toBe(0x77);
  });

  it('writes under the BIOS to the RAM at $D000-$DFFF', () => {
    const m = mem();
    m.z80Write(0x0123, 0x5A);
    expect(m.ram[0xD123]).toBe(0x5A);
    expect(m.ram[0x0123]).toBe(0);
  });

  it('sees the colour RAM at $1000-$13FF while I/O is on, and RAM when it is off', () => {
    const m = mem();
    m.ram[0x1005] = 0x99;
    m.colorBanks[0][5] = 0x07;
    expect(m.z80Read(0x1005)).toBe(0x07);
    m.z80Write(0x1006, 0xFD);
    expect(m.colorBanks[0][6]).toBe(0x0D);
    m.mmu.write(0, 0x01);
    expect(m.z80Read(0x1005)).toBe(0x99);
  });

  it('sees the same ROMs and RAM as the 8502 elsewhere, and never I/O at $D000', () => {
    const m = mem();
    m.ram[0x5000] = 0x55;
    expect(m.z80Read(0x5000)).toBe(BASIC_LO);
    m.mmu.write(0, 0x02);
    expect(m.z80Read(0x5000)).toBe(0x55);
    m.mmu.write(0, 0x00);
    expect(m.z80Read(0xD000), 'the 128 character set, not I/O').toBe(CHARGEN128);
  });

  it('reaches the MMU through $FF00 as the 8502 does', () => {
    const m = mem();
    m.z80Write(0xFF00, 0x3E);
    expect(m.mmu.cr).toBe(0x3E);
    expect(m.z80Read(0xFF00)).toBe(0x3E);
  });

  it('reaches I/O with IN and OUT through the $Dxxx port address, whatever CR bit 0 says (an I/O cycle is not a memory one)', () => {
    const m = mem();
    const out: [number, number][] = [];
    m.ioWrite = (addr, v) => { out.push([addr, v]); };
    m.z80Out(0xD505, 0xB1);
    expect(out).toEqual([[0xD505, 0xB1]]);
    expect(m.z80In(0xDC01)).toBe(0x10 | 0x01);
    // With the I/O page switched out of the memory map the instructions still get there: the
    // VICE test program tstz80bk, which runs on real machines, restores the MMU's pointers
    // that way (CR = $BF) and passes only so.
    m.mmu.write(0, 0x01);
    m.z80Out(0xD505, 0x00);
    expect(out.length).toBe(2);
    expect(m.z80In(0xDC01)).toBe(0x10 | 0x01);
  });

  it('turns an IN or OUT with a port address below $1000 into a RAM access at $Dxxx', () => {
    const m = mem();
    m.z80Out(0x0123, 0x42);
    expect(m.ram[0xD123]).toBe(0x42);
    expect(m.z80In(0x0123)).toBe(0x42);
  });
});

describe('C128 memory: the VIC-IIe window', () => {
  it('reads RAM block 0 or 1 as RCR bits 7-6 say, at the bank CIA 2 chooses', () => {
    const m = mem();
    m.ram[0x4010] = 0x41; m.ram[0x14010] = 0x51;
    m.setVicBank(1);
    expect(m.vicRead(0x0010)).toBe(0x41);
    m.mmu.write(6, 0x40);
    expect(m.vicRead(0x0010)).toBe(0x51);
  });

  it('shows the 128 character ROM at $1000-$1FFF of every bank while port bit 2 is low', () => {
    const m = mem();
    m.writeByte(0, 0x04);
    m.writeByte(1, 0x00);
    for (const bank of [0, 1, 2, 3]) {
      m.setVicBank(bank);
      expect(m.vicRead(0x1000), `bank ${bank}`).toBe(CHARGEN128);
      expect(m.vicRead(0x1FFF)).toBe(CHARGEN128);
      expect(m.vicRead(0x0FFF)).toBe(0x00);
      expect(m.vicRead(0x2000)).toBe(0x00);
    }
  });

  it('shows RAM there while port bit 2 is high', () => {
    const m = mem();
    m.ram[0x1000] = 0x66;
    m.writeByte(0, 0x00);
    expect(m.vicRead(0x1000)).toBe(0x66);
  });
});

describe('C128 memory: the debugger', () => {
  it('peeks without touching I/O, the port or the read count', () => {
    const m = mem();
    let touched = 0;
    m.ioRead = () => { touched++; return 0; };
    m.ioPeek = () => 0x5A;
    expect(m.peekByte(0xD000)).toBe(0x5A);
    m.peekByte(1);
    expect(touched).toBe(0);
    expect(m.portReads).toBe(0);
    m.readByte(1);
    expect(m.portReads).toBe(1);
  });

  it('gives a 64K snapshot of what the CPU sees and eight 16K RAM banks', () => {
    const m = mem();
    m.ram[0x10000 + 0x4000] = 0x77;
    const snap = m.snapshot();
    expect(snap.length).toBe(0x10000);
    expect(snap[0x4000]).toBe(BASIC_LO);
    expect(m.ramBankCount).toBe(8);
    expect(m.getRamBank(5)[0]).toBe(0x77);
  });
});

// ── C64 mode ────────────────────────────────────────────────────────────────

const BASIC64 = 0xA6, KERNAL64 = 0xE6, CHAR64 = 0xC6;

/** A 128 switched to C64 mode: the MMU's mode register bit 6, the 64's own ROMs, and I/O answering $1x. */
function mem64(): C128Memory {
  const m = mem();
  m.basic64.fill(BASIC64);
  m.kernal64.fill(KERNAL64);
  m.chargen.fill(CHAR64, 0, 0x1000);
  m.mmu.write(5, 0x40);
  m.writeByte(0, 0x07);                          // DDR: the three PLA lines are outputs
  return m;
}

/** What the 8502 reads at BASIC, the character/I/O area and the KERNAL under a port value. */
function map64(m: C128Memory, port: number): { basic: number; d: number; kernal: number } {
  m.writeByte(1, port);
  return { basic: m.readByte(0xA000), d: m.readByte(0xD000), kernal: m.readByte(0xE000) };
}

describe('C128 memory: C64 mode map', () => {
  const RAM = 0x00;
  const IO = 0x10;
  // The 64's PLA with nothing in the cartridge port, by (CHAREN, HIRAM, LORAM).
  const table: [number, string, { basic: number; d: number; kernal: number }][] = [
    [0b000, 'all RAM', { basic: RAM, d: RAM, kernal: RAM }],
    [0b001, 'LORAM only: character ROM', { basic: RAM, d: CHAR64, kernal: RAM }],
    [0b010, 'HIRAM only: character ROM and KERNAL', { basic: RAM, d: CHAR64, kernal: KERNAL64 }],
    [0b011, 'BASIC, character ROM, KERNAL', { basic: BASIC64, d: CHAR64, kernal: KERNAL64 }],
    [0b100, 'CHAREN alone: still all RAM', { basic: RAM, d: RAM, kernal: RAM }],
    [0b101, 'LORAM and CHAREN: I/O', { basic: RAM, d: IO, kernal: RAM }],
    [0b110, 'HIRAM and CHAREN: I/O and KERNAL', { basic: RAM, d: IO, kernal: KERNAL64 }],
    [0b111, 'BASIC, I/O, KERNAL', { basic: BASIC64, d: IO, kernal: KERNAL64 }],
  ];

  it.each(table)('port %i (%s)', (port, _name, want) => {
    const m = mem64();
    expect(map64(m, port)).toEqual(want);
  });

  it('reads the 64 BASIC and KERNAL from their own ROMs, not the 128\'s', () => {
    const m = mem64();
    m.writeByte(1, 7);
    expect(m.readByte(0xBFFF)).toBe(BASIC64);
    expect(m.readByte(0xFFFF)).toBe(KERNAL64);
    expect(m.readByte(0x4000), 'no low BASIC ROM in this mode').toBe(0);
    expect(m.readByte(0x8000), 'and nothing at $8000').toBe(0);
    expect(m.readByte(0xC000), 'nor the editor at $C000').toBe(0);
  });

  it('starts with the pulled-up port lines reading 1, so the KERNAL and BASIC are in view', () => {
    const m = new C128Memory();
    m.basic64.fill(BASIC64);
    m.kernal64.fill(KERNAL64);
    m.mmu.write(5, 0x40);
    expect(m.readByte(0xA000)).toBe(BASIC64);
    expect(m.readByte(0xFFFC)).toBe(KERNAL64);
  });

  it('writes go to the RAM under a ROM, and to I/O only where I/O is in view', () => {
    const m = mem64();
    let io = 0;
    m.ioWrite = () => { io++; };
    m.writeByte(1, 7);
    m.writeByte(0xA000, 0x5A);
    m.writeByte(0xE000, 0x6B);
    m.writeByte(0xD000, 0x7C);
    expect([m.ram[0xA000], m.ram[0xE000], m.ram[0xD000]]).toEqual([0x5A, 0x6B, 0]);
    expect(io).toBe(1);
    m.writeByte(1, 3);                           // character ROM in view: the write is to RAM
    m.writeByte(0xD000, 0x7D);
    expect(m.ram[0xD000]).toBe(0x7D);
    expect(io).toBe(1);
  });

  it('keeps the CPU in one RAM block: the one CR names', () => {
    const m = mem64();
    m.writeByte(1, 0);
    m.writeByte(0x2000, 0x11);
    m.mmu.write(0, 0x40);
    expect(m.readByte(0x2000)).toBe(0);
    m.writeByte(0x2000, 0x22);
    expect([m.ram[0x2000], m.ram[0x12000]]).toEqual([0x11, 0x22]);
  });

  it('is not at $FF00: writes there are RAM and CR is untouched', () => {
    const m = mem64();
    m.writeByte(1, 0);
    m.writeByte(0xFF00, 0x7E);
    m.writeByte(0xFF01, 0x7E);
    expect(m.ram[0xFF00]).toBe(0x7E);
    expect(m.mmu.cr).toBe(0);
    expect(m.readByte(0xFF01)).toBe(0x7E);
  });

  it('does not relocate pages 0 and 1', () => {
    const m = mem64();
    m.writeByte(1, 0);
    m.mmu.write(7, 0x40);                        // page 0 pointed at $4000 in the 128's view
    m.writeByte(0x0010, 0x9A);
    expect(m.ram[0x0010]).toBe(0x9A);
    expect(m.ram[0x4010]).toBe(0);
  });

  it('puts the 8502 port lines on the PLA, so bit 0 no longer picks a colour RAM bank', () => {
    const m = mem64();
    m.colorWrite(0xD800, 0x05);
    m.writeByte(1, 0x06);                        // bit 0 low would pick bank 1 in C128 mode
    expect(m.colorRead(0xD800)).toBe(0x05);
    expect(m.colorRam).toBe(m.colorBanks[0]);
    m.mmu.write(5, 0x00);                        // back to C128 mode: the port steers the banks again
    expect(m.colorRead(0xD800)).not.toBe(0x05);
  });

  it('peeks the same map without touching I/O', () => {
    const m = mem64();
    let touched = 0;
    m.ioRead = () => { touched++; return 0; };
    m.ioPeek = () => 0x5A;
    m.writeByte(1, 7);
    expect(m.peekByte(0xD000)).toBe(0x5A);
    expect(m.peekByte(0xE000)).toBe(KERNAL64);
    expect(touched).toBe(0);
  });

  it('reports whether I/O is in view', () => {
    const m = mem64();
    m.writeByte(1, 7);
    expect(m.ioIn).toBe(true);
    m.writeByte(1, 3);
    expect(m.ioIn).toBe(false);
  });

  it('shows the VIC-II the 64\'s 4K character set in banks 0 and 2 only', () => {
    const m = mem64();
    m.ram[0x1000] = 0x11;
    m.ram[0x4000 + 0x1000] = 0x22;
    m.ram[0x8000 + 0x1000] = 0x33;
    m.ram[0xC000 + 0x1000] = 0x44;
    const seen = (bank: number): number => { m.setVicBank(bank); return m.vicRead(0x1000); };
    expect(seen(0)).toBe(CHAR64);
    expect(seen(1)).toBe(0x22);
    expect(seen(2)).toBe(CHAR64);
    expect(seen(3)).toBe(0x44);
    m.setVicBank(0);
    expect(m.vicRead(0x0800), 'only the 4K at $1000').toBe(0);
  });

  it('shows the 128\'s own set to the VIC-IIe in C128 mode, and the 64\'s to the VIC-II in C64 mode', () => {
    const m = mem64();
    m.mmu.write(5, 0x00);
    m.writeByte(1, 0);                           // port bit 2 low: character ROM visible
    expect(m.vicRead(0x1000)).toBe(CHARGEN128);
    m.mmu.write(5, 0x40);
    expect(m.vicRead(0x1000)).toBe(CHAR64);
  });

  it('puts the 128 ROMs back when the mode register says C128', () => {
    const m = mem64();
    m.mmu.write(5, 0x00);
    m.mmu.write(0, 0x00);
    expect(m.readByte(0x4000)).toBe(BASIC_LO);
    expect(m.readByte(0xE000)).toBe(KERNAL);
  });
});
