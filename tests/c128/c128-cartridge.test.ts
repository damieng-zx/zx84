/**
 * The expansion port on the 128: a 64 cartridge seen in C64 mode (the 64's map
 * from the EXROM and GAME lines, the boards' bank switching in I/O 1 and 2),
 * a 128 function ROM the MMU maps over $8000-$FFFF, the lines the MMU's mode
 * register reads back, snapshots, the services, and — with the real ROMs —
 * the BIOS starting a 64 cartridge in C64 mode and BASIC 7.0 finding a
 * function ROM. ROMs are built by hand so every byte read back was put there.
 */

import { describe, it, expect } from 'vitest';
import { C128Machine } from '@/machines/c128/c128-machine.ts';
import { C128FunctionRom, parseC128Cartridge, parseC128Crt, parseFunctionRomImage } from '@/machines/c128/function-rom.ts';
import { parseCrt, type C64Cartridge } from '@/machines/shared/cbm/cartridge.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';
import { buildCrt, rom8k, type CrtChip } from '../c64/crt-helper.ts';

function cartOf(crt: Uint8Array): C64Cartridge {
  const parsed = parseCrt(crt);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.cart;
}

/** A 128 `.crt` by hand: the 64's layout with the 128's signature and hardware type `hw`. */
function buildC128Crt(chips: readonly CrtChip[], name = 'F', hw = 0): Uint8Array {
  const crt = buildCrt(hw, 1, 1, chips, name);
  crt.set([...'C128 CARTRIDGE  '].map(c => c.charCodeAt(0)), 0);
  return crt;
}

/** A 128 with a 64 cartridge fitted and started over, as a person would, then put in C64 mode. */
function fit64(crt: Uint8Array, pla = 0x37): C128Machine {
  const m = new C128Machine(null);
  m.loadRoms(null, null, null, null, new Uint8Array(0x2000).fill(0xB5), new Uint8Array(0x2000).fill(0xE5));
  m.setCartridge(cartOf(crt));
  m.reset();
  m.memory.mmu.mcr = 0x70;
  m.memory.pinsChanged();
  m.memory.writeByte(0, 0x2F);
  m.memory.writeByte(1, pla);
  return m;
}

const rd = (m: C128Machine, addr: number): number => m.memory.readByte(addr);
const wr = (m: C128Machine, addr: number, v: number): void => m.memory.writeByte(addr, v);
const banks = (load: number, count: number): CrtChip[] =>
  Array.from({ length: count }, (_, bank) => ({ bank, load, data: rom8k(bank + 1) }));

describe('a 64 cartridge on the 128, in C64 mode', () => {
  it('maps an 8K cartridge at $8000 and leaves BASIC at $A000', () => {
    const m = fit64(buildCrt(0, 0, 1, [{ bank: 0, load: 0x8000, data: rom8k(0x5A) }]));
    expect(rd(m, 0x8000)).toBe(0x5A);
    expect(rd(m, 0xA000), 'the 64 BASIC').toBe(0xB5);
    // The ROM hides under a write: it reaches the RAM beneath.
    wr(m, 0x8000, 0x11);
    expect(rd(m, 0x8000)).toBe(0x5A);
    expect(m.memory.ram[0x8000]).toBe(0x11);
    m.destroy();
  });

  it('maps a 16K cartridge at $8000 and $A000, in place of BASIC', () => {
    const m = fit64(buildCrt(0, 0, 0, [{ bank: 0, load: 0x8000, data: new Uint8Array(0x4000).fill(0x66) }]));
    expect(rd(m, 0x8000)).toBe(0x66);
    expect(rd(m, 0xA000)).toBe(0x66);
    expect(rd(m, 0xE000), 'the KERNAL stays').toBe(0xE5);
    m.destroy();
  });

  it('shows the ROM only while the port keeps LORAM and HIRAM high', () => {
    const m = fit64(buildCrt(0, 0, 1, [{ bank: 0, load: 0x8000, data: rom8k(0x5A) }]), 0x34);
    expect(rd(m, 0x8000), 'all RAM').not.toBe(0x5A);
    m.destroy();
  });

  it('maps an Ultimax cartridge at $E000 with the middle of the map open', () => {
    const m = fit64(buildCrt(0, 1, 0, [
      { bank: 0, load: 0x8000, data: rom8k(0x71) },
      { bank: 0, load: 0xE000, data: rom8k(0x72) },
    ]));
    expect(m.memory.ultimax).toBe(true);
    expect(rd(m, 0x8000)).toBe(0x71);
    expect(rd(m, 0xE000)).toBe(0x72);
    expect(rd(m, 0xC000), 'open').toBe(0xFF);
    expect(rd(m, 0xA000), 'open').toBe(0xFF);
    wr(m, 0x2000, 0x44);
    expect(m.memory.ram[0x2000], 'no RAM above $1000').not.toBe(0x44);
    wr(m, 0x0400, 0x44);
    expect(rd(m, 0x0400)).toBe(0x44);
    m.destroy();
  });

  it('lets the VIC-II see the ROMH of an Ultimax cartridge at $3000 of its bank', () => {
    const m = fit64(buildCrt(0, 1, 0, [{ bank: 0, load: 0xE000, data: rom8k(0x72, [[0x1000, [0x99]]]) }]));
    expect(m.memory.vicRead(0x3000)).toBe(0x99);
    m.destroy();
  });

  it('switches banks through I/O 1 on an Ocean board', () => {
    const m = fit64(buildCrt(5, 0, 1, banks(0x8000, 16)));
    expect(rd(m, 0x8000)).toBe(1);
    wr(m, 0xDE00, 6);
    expect(rd(m, 0x8000)).toBe(7);
    m.destroy();
  });

  it('is not reached through I/O in C128 mode', () => {
    const m = fit64(buildCrt(5, 0, 1, banks(0x8000, 16)));
    m.memory.mmu.mcr = 0x30;
    m.memory.pinsChanged();
    m.memory.mmu.cr = 0;                       // I/O on
    wr(m, 0xDE00, 6);
    expect(m.cartridge?.describe()[0] ?? '').toContain('ROML bank 0');
    m.destroy();
  });

  it('pulls the lines the MMU\'s mode register reads at bits 5-4 low, and releases them when taken out', () => {
    const m = fit64(buildCrt(0, 0, 1, [{ bank: 0, load: 0x8000, data: rom8k(0x5A) }]));
    expect(m.memory.mmu.read(5) & 0x30, 'EXROM low, GAME high').toBe(0x10);
    m.ejectCartridge();
    expect(m.memory.mmu.read(5) & 0x30).toBe(0x30);
    expect(m.cartridge).toBeNull();
    m.destroy();
  });
});

describe('a 128 function ROM', () => {
  const lowHigh = (): C128FunctionRom => {
    const parsed = parseC128Crt(buildC128Crt([
      { bank: 0, load: 0x8000, data: new Uint8Array(0x4000).fill(0x81) },
      { bank: 0, load: 0xC000, data: new Uint8Array(0x4000).fill(0xC1) },
    ]));
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed.rom;
  };

  it('is read from a C128 .crt, chips at $8000 and $C000', () => {
    const rom = lowHigh();
    expect(rom.byte(0x8000)).toBe(0x81);
    expect(rom.byte(0xBFFF)).toBe(0x81);
    expect(rom.byte(0xC000)).toBe(0xC1);
    expect(rom.byte(0xFFFF)).toBe(0xC1);
    expect(parseC128Cartridge(buildC128Crt([{ bank: 0, load: 0x8000, data: rom8k(1) }]), 'a.crt')).toHaveProperty('rom');
  });

  it('puts an 8K chip at $A000 in the upper half of the low 16K', () => {
    const parsed = parseC128Crt(buildC128Crt([{ bank: 0, load: 0xA000, data: rom8k(0x33) }]));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.rom.byte(0x8000)).toBe(0xFF);
    expect(parsed.rom.byte(0xA000)).toBe(0x33);
  });

  it('refuses what it cannot map', () => {
    expect(parseC128Crt(buildC128Crt([{ bank: 1, load: 0x8000, data: rom8k(1) }]))).toMatchObject({ error: expect.stringContaining('no banks') });
    expect(parseC128Crt(buildC128Crt([{ bank: 0, load: 0x4000, data: rom8k(1) }]))).toMatchObject({ error: expect.stringContaining('not a function ROM address') });
    expect(parseC128Crt(buildC128Crt([]))).toMatchObject({ error: 'Cartridge file holds no ROM' });
    expect(parseC128Cartridge(new Uint8Array(100), 'x.crt')).toMatchObject({ error: expect.any(String) });
    expect(parseC128Cartridge(new Uint8Array(1234), 'x.bin')).toMatchObject({ error: expect.stringContaining('8K, 16K or 32K') });
  });

  it('takes a bare 8K, 16K or 32K image, the low half first', () => {
    for (const [size, hi] of [[0x2000, 0xFF], [0x4000, 0xFF], [0x8000, 0xAA]] as const) {
      const data = new Uint8Array(size).fill(0x55);
      if (size === 0x8000) data.fill(hi, 0x4000);
      const parsed = parseFunctionRomImage(data, 'f.bin');
      if ('error' in parsed) throw new Error(parsed.error);
      expect(parsed.rom.byte(0x8000)).toBe(0x55);
      expect(parsed.rom.byte(0xC000)).toBe(hi);
    }
  });

  it('shows over $8000-$BFFF and $C000-$FFFF as CR bits 3-2 and 5-4 say, and leaves BASIC otherwise', () => {
    const m = new C128Machine(null);
    m.memory.basicHi.fill(0x42);
    m.memory.kernal.fill(0x43);
    m.setCartridge(null, lowHigh());
    const mmu = m.memory.mmu;
    expect([rd(m, 0x8000), rd(m, 0xC000)], 'internal/system ROM by default').toEqual([0x42, 0x43]);
    mmu.cr = 0x08;                               // external function ROM at $8000-$BFFF
    expect([rd(m, 0x8000), rd(m, 0xBFFF), rd(m, 0xC000)]).toEqual([0x81, 0x81, 0x43]);
    mmu.cr = 0x20;                               // and at $C000-$FFFF
    expect([rd(m, 0x8000), rd(m, 0xC000), rd(m, 0xFFF0)]).toEqual([0x42, 0xC1, 0xC1]);
    mmu.cr = 0x04;                               // internal: an empty socket
    expect(rd(m, 0x8000)).toBe(0xFF);
    m.destroy();
  });

  it('leaves /EXROM and /GAME high, so the BIOS does not take it for a 64 cartridge', () => {
    const m = new C128Machine(null);
    m.setCartridge(null, lowHigh());
    expect(m.memory.mmu.read(5) & 0x30).toBe(0x30);
    expect(m.cartridge?.name).toBe('F');
    m.destroy();
  });
});

/** A 16K chip whose every byte is `fill`, with `bytes` placed from `at`. */
const rom16k = (fill: number, bytes: ReadonlyArray<readonly [number, readonly number[]]> = []): Uint8Array => {
  const d = new Uint8Array(0x4000).fill(fill);
  for (const [at, b] of bytes) d.set(b, at);
  return d;
};

function board(hw: number, chips: CrtChip[]): { m: C128Machine; rom: C128FunctionRom } {
  const parsed = parseC128Crt(buildC128Crt(chips, 'B', hw));
  if ('error' in parsed) throw new Error(parsed.error);
  const m = new C128Machine(null);
  m.setCartridge(null, parsed.rom);
  m.reset();
  m.memory.mmu.cr = 0x08;                      // external function ROM at $8000-$BFFF, I/O on
  return { m, rom: parsed.rom };
}

describe('banked 128 cartridges', () => {
  it('switches Magic Desk 128 banks with the low six bits of a write to $DE00', () => {
    const { m, rom } = board(4, [0, 1, 2, 33].map(bank => ({ bank, load: 0x8000, data: rom16k(0x10 + bank) })));
    expect(rom.type).toBe('magicdesk');
    expect(rd(m, 0x8000), 'bank 0 at power-up').toBe(0x10);
    wr(m, 0xDE00, 2);
    expect(rd(m, 0x8000)).toBe(0x12);
    expect(rd(m, 0xBFFF)).toBe(0x12);
    wr(m, 0xDE00, 0x80 | 33);                  // the top two bits are not used
    expect(rd(m, 0x8000)).toBe(0x31);
    wr(m, 0xDE00, 7);
    expect(rd(m, 0x8000), 'a bank with nothing in it').toBe(0xFF);
    wr(m, 0xDE01, 2);
    expect(rom.bank, 'only $DE00 is the register').toBe(7);
    m.reset();
    expect(m.cartridge instanceof C128FunctionRom ? m.cartridge.bank : -1, 'back to bank 0 on reset').toBe(0);
    m.destroy();
  });

  it('refuses a bank number out of range, and any bank on a board that has none', () => {
    expect(parseC128Crt(buildC128Crt([{ bank: 64, load: 0x8000, data: rom16k(1) }], 'M', 4))).toMatchObject({ error: expect.stringContaining('out of range') });
    expect(parseC128Crt(buildC128Crt([{ bank: 1, load: 0x8000, data: rom16k(1) }], 'W', 1))).toMatchObject({ error: expect.stringContaining('no banks') });
    expect(parseC128Crt(buildC128Crt([{ bank: 0, load: 0xC000, data: rom16k(1) }], 'W', 1))).toMatchObject({ error: expect.stringContaining('nothing at $C000') });
  });

  it('refuses the boards whose registers the manual does not describe, by name', () => {
    expect(parseC128Crt(buildC128Crt([{ bank: 0, load: 0xC000, data: rom16k(1) }], 'C', 3))).toMatchObject({ error: expect.stringContaining('Comal 80') });
    expect(parseC128Crt(buildC128Crt([{ bank: 0, load: 0x8000, data: rom16k(1) }], 'G', 5))).toMatchObject({ error: expect.stringContaining('Gmod2-C128') });
    expect(parseC128Crt(buildC128Crt([{ bank: 0, load: 0x8000, data: rom16k(1) }], 'X', 9))).toMatchObject({ error: expect.stringContaining('type 9') });
  });

  it('shows the Warpspeed128 ROM at $9E00-$9FFF again at $DE00-$DFFF', () => {
    const { m } = board(1, [{ bank: 0, load: 0x8000, data: rom16k(0x11, [[0x1E00, [0xAA]], [0x1FFF, [0xBB]]]) }]);
    expect(rd(m, 0x9E00)).toBe(0xAA);
    expect(rd(m, 0xDE00)).toBe(0xAA);
    expect(rd(m, 0xDFFF)).toBe(0xBB);
    expect(rd(m, 0xDE01), 'the rest of it too').toBe(0x11);
    m.destroy();
  });

  it('gives Partner 128 its RAM window at $DE00, 64 blocks picked by $DE80, and the ROM at $DE80-$DEFF', () => {
    const { m, rom } = board(2, [{ bank: 0, load: 0x8000, data: rom16k(0x22, [[0x1E80, [0xCC]]]) }]);
    expect(rd(m, 0xDE80), 'ROM from $9E80').toBe(0xCC);
    wr(m, 0xDE00, 0x41);
    wr(m, 0xDE7F, 0x42);
    expect([rd(m, 0xDE00), rd(m, 0xDE7F)]).toEqual([0x41, 0x42]);
    wr(m, 0xDE80, 5);                          // block 5 is a clean one
    expect(rom.ramBlock).toBe(5);
    expect(rd(m, 0xDE00)).toBe(0);
    wr(m, 0xDE00, 0x55);
    wr(m, 0xDE80, 0x40 | 0);                   // only six bits: back to block 0
    expect(rd(m, 0xDE00)).toBe(0x41);
    wr(m, 0xDE80, 5);
    expect(rd(m, 0xDE00)).toBe(0x55);
    expect(rd(m, 0xDE80), 'a write to $DE80 did not touch the ROM').toBe(0xCC);
    expect(rd(m, 0x8000), 'the ROM is not banked').toBe(0x22);
    m.destroy();
  });

  it('keeps the bank and the RAM in a snapshot', () => {
    const { m: a } = board(4, [0, 1, 2].map(bank => ({ bank, load: 0x8000, data: rom16k(0x10 + bank) })));
    wr(a, 0xDE00, 2);
    const w = new StateWriter();
    a.saveState(w, false);
    const b = new C128Machine(null);
    b.loadState(new StateReader(w.finish()));
    b.memory.mmu.cr = 0x08;
    expect(rd(b, 0x8000)).toBe(0x12);
    expect(b.cartridge instanceof C128FunctionRom ? b.cartridge.type : '').toBe('magicdesk');

    const { m: c, rom } = board(2, [{ bank: 0, load: 0x8000, data: rom16k(0x22) }]);
    wr(c, 0xDE80, 9);
    wr(c, 0xDE10, 0x77);
    const w2 = new StateWriter();
    c.saveState(w2, false);
    const d = new C128Machine(null);
    d.loadState(new StateReader(w2.finish()));
    d.memory.mmu.cr = 0x08;
    expect(rd(d, 0xDE10)).toBe(0x77);
    expect(rom.ramBlock).toBe(9);
    a.destroy(); b.destroy(); c.destroy(); d.destroy();
  });

  it('is mounted through the media service with the board named', async () => {
    const m = new C128Machine(null);
    const r = await m.services.media.mount(buildC128Crt([{ bank: 0, load: 0x8000, data: rom16k(1) }], 'MD', 4), 'desk.crt');
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining('Magic Desk 128') });
    m.destroy();
  });
});

describe('cartridges in snapshots and through the services', () => {
  it('keeps a 64 cartridge and its bank in a snapshot, and takes it off for one without', () => {
    const a = fit64(buildCrt(5, 0, 1, banks(0x8000, 16)));
    wr(a, 0xDE00, 6);
    const w = new StateWriter();
    a.saveState(w, false);
    const b = new C128Machine(null);
    b.loadState(new StateReader(w.finish()));
    expect(b.cartridge && !(b.cartridge instanceof C128FunctionRom) ? b.cartridge.type : '').toBe('ocean');
    b.memory.mmu.mcr = 0x70;
    b.memory.pinsChanged();
    b.memory.writeByte(0, 0x2F); b.memory.writeByte(1, 0x37);
    expect(rd(b, 0x8000)).toBe(7);
    const empty = new C128Machine(null);
    empty.reset();
    const w2 = new StateWriter();
    empty.saveState(w2, false);
    b.loadState(new StateReader(w2.finish()));
    expect(b.cartridge).toBeNull();
    a.destroy(); b.destroy(); empty.destroy();
  });

  it('keeps a function ROM in a snapshot', () => {
    const a = new C128Machine(null);
    const parsed = parseFunctionRomImage(new Uint8Array(0x8000).fill(0x77), 'tool.bin');
    if ('error' in parsed) throw new Error(parsed.error);
    a.setCartridge(null, parsed.rom);
    const w = new StateWriter();
    a.saveState(w, false);
    const b = new C128Machine(null);
    b.loadState(new StateReader(w.finish()));
    expect(b.cartridge?.name).toBe('tool.bin');
    b.memory.mmu.cr = 0x28;
    expect([rd(b, 0x8000), rd(b, 0xC000)]).toEqual([0x77, 0x77]);
    a.destroy(); b.destroy();
  });

  it('mounts a .crt through the media service, ejects it, and starts over each time', async () => {
    const m = new C128Machine(null);
    m.memory.ram[0x0400] = 0x99;
    const crt = buildCrt(0, 0, 1, [{ bank: 0, load: 0x8000, data: rom8k(0x5A) }]);
    const r = await m.services.media.mount(crt, 'game.crt');
    expect(r).toMatchObject({ ok: true, target: 'cartridge' });
    expect(m.services.roms.cartridge?.name).toBe('game.crt');
    expect(m.memory.ram[0x0400], 'power-cycled').not.toBe(0x99);
    expect(await m.services.media.mount(new Uint8Array(100), 'x.crt')).toMatchObject({ ok: false });
    const f = await m.services.media.mount(buildC128Crt([{ bank: 0, load: 0x8000, data: rom8k(1) }]), 'tool.crt');
    expect(f).toMatchObject({ ok: true, message: expect.stringContaining('function ROM') });
    expect(m.memory.cart, 'one thing on the port at a time').toBeNull();
    m.services.roms.cartridge?.eject();
    expect(m.cartridge).toBeNull();
    expect(m.services.roms.cartridge?.name).toBe('');
    m.destroy();
  });

  it('takes a bare function ROM image in the ROM pane\'s cartridge slot', () => {
    const m = new C128Machine(null);
    m.services.roms.cartridge?.insert(new Uint8Array(0x4000).fill(0x12), 'f.bin');
    expect(m.memory.extRom?.byte(0x8000)).toBe(0x12);
    m.destroy();
  });

  it('describes what is on the port to the memory map and chips panes', () => {
    const m = fit64(buildCrt(0, 1, 0, [{ bank: 0, load: 0xE000, data: rom8k(0x72) }]));
    const map = m.services.probe.panes!.memoryMap!();
    expect(map?.slots.find(s => s.range === 'E000-FFFF')?.read).toBe('Cartridge ROMH');
    expect(map?.registers.find(r => r.name === 'Cartridge')?.value).toContain('Ultimax');
    expect(m.chips().some(c => c.name === 'cart')).toBe(true);
    m.destroy();
  });
});

const REAL = 'c128-dev/';
const basicLo = romImage(REAL + 'basiclo');
const basicHi = romImage(REAL + 'basichi');
const kernal = romImage(REAL + 'kernal');
const chargen = romImage(REAL + 'chargen');
const basic64 = romImage(REAL + 'basic64');
const kernal64 = romImage(REAL + 'kernal64');

describe.skipIf(!basicLo || !basicHi || !kernal || !chargen || !basic64 || !kernal64)('cartridges with the Commodore ROMs', () => {
  function bootWith(setup: (m: C128Machine) => void, frames = 200): C128Machine {
    const m = new C128Machine(null);
    m.loadRoms(basicLo, basicHi, kernal, chargen, basic64, kernal64);
    setup(m);
    m.reset();
    for (let f = 0; f < frames; f++) m.tick();
    return m;
  }

  /** A 64 cartridge that boots: the CBM80 signature and a cold start that writes to the screen. */
  const bootCart = (): Uint8Array => {
    const rom = new Uint8Array(0x2000).fill(0xFF);
    // $8000: cold start, warm start, then CBM80.
    rom.set([0x09, 0x80, 0x09, 0x80, 0xC3, 0xC2, 0xCD, 0x38, 0x30], 0);
    // $8009: LDA #$58 : STA $0400 : LDA #$01 : STA $D800 : JMP *
    rom.set([0xA9, 0x58, 0x8D, 0x00, 0x04, 0xA9, 0x01, 0x8D, 0x00, 0xD8, 0x4C, 0x0F, 0x80], 9);
    return buildCrt(0, 0, 1, [{ bank: 0, load: 0x8000, data: rom }]);
  };

  it('starts in C64 mode and runs a 64 cartridge by its CBM80 signature', () => {
    const m = bootWith(mach => mach.setCartridge(cartOf(bootCart())));
    expect(m.c64Mode, 'the BIOS saw the cartridge lines low').toBe(true);
    expect(m.memory.ram[0x0400], 'its cold start ran').toBe(0x58);
    m.destroy();
  });

  it('without one still starts in C128 mode', () => {
    const m = bootWith(() => {});
    expect(m.c64Mode).toBe(false);
    m.destroy();
  });

  it('lets the KERNAL find a function ROM and run it by its CBM signature', () => {
    const rom = new Uint8Array(0x4000).fill(0xFF);
    // $8000: JMP cold, JMP warm, type 1 (autoboot), "CBM"; cold start: LDA #$58 : STA $0400 : JMP *
    rom.set([0x4C, 0x0A, 0x80, 0x4C, 0x0A, 0x80, 0x01, 0x43, 0x42, 0x4D], 0);
    rom.set([0xA9, 0x58, 0x8D, 0x00, 0x04, 0x4C, 0x0F, 0x80], 0x0A);
    const parsed = parseFunctionRomImage(rom, 'tool.bin');
    if ('error' in parsed) throw new Error(parsed.error);
    const m = bootWith(mach => mach.setCartridge(null, parsed.rom), 250);
    expect(m.c64Mode).toBe(false);
    // The KERNAL read the CBM header from the external function ROM and ran its cold start.
    expect(m.memory.ram[0x0400]).toBe(0x58);
    m.destroy();
  });
});
