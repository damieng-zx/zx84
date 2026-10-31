/**
 * Cartridges on the expansion port: the `.crt` file, the memory map the EXROM
 * and GAME lines make, and each supported board's bank switching. The ROMs are
 * built by hand so every byte read back is one the test put there.
 */

import { describe, it, expect } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import { parseCrt, type C64Cartridge } from '@/machines/c64/cartridge.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';
import { buildCrt, rom8k, type CrtChip } from './crt-helper.ts';

function cartOf(crt: Uint8Array): C64Cartridge {
  const parsed = parseCrt(crt);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.cart;
}

/** A machine with the cartridge fitted and started over, as a person would. */
function fit(crt: Uint8Array): C64Machine {
  const m = new C64Machine('c64', null);
  m.setCartridge(cartOf(crt));
  m.reset();
  return m;
}

/** Banks of 8K each filled with a value that says which bank a read came from. */
const banks = (load: number, count: number, fill: (n: number) => number = n => n + 1): CrtChip[] =>
  Array.from({ length: count }, (_, bank) => ({ bank, load, data: rom8k(fill(bank)) }));

const rd = (m: C64Machine, addr: number): number => m.memory.readByte(addr);
const wr = (m: C64Machine, addr: number, v: number): void => m.memory.writeByte(addr, v);
/** The 6510 port: the PLA lines are outputs, set to `pla` (bit 0 LORAM, 1 HIRAM, 2 CHAREN). */
function port(m: C64Machine, pla: number): void { wr(m, 0, 0x2F); wr(m, 1, pla | 0x30); }

describe('.crt files', () => {
  it('reads the name, the lines and the banks', () => {
    const cart = cartOf(buildCrt(5, 0, 1, banks(0x8000, 4), 'OCEAN TEST'));
    expect(cart.type).toBe('ocean');
    expect(cart.name).toBe('OCEAN TEST');
    expect(cart.lines).toEqual({ exrom: 0, game: 1 });
  });

  it('splits a 16K chip at $8000 into ROML and ROMH', () => {
    const data = new Uint8Array(0x4000);
    data.fill(0x11, 0, 0x2000);
    data.fill(0x22, 0x2000);
    const cart = cartOf(buildCrt(0, 0, 0, [{ bank: 0, load: 0x8000, data }]));
    expect(cart.readRoml(0)).toBe(0x11);
    expect(cart.readRomh(0)).toBe(0x22);
  });

  it('mirrors a 4K chip to fill its window', () => {
    const data = new Uint8Array(0x1000).fill(0x33);
    data[0] = 0x44;
    const cart = cartOf(buildCrt(0, 0, 1, [{ bank: 0, load: 0x8000, data }]));
    expect(cart.readRoml(0x1000)).toBe(0x44);
    expect(cart.readRoml(0x1FFF)).toBe(0x33);
  });

  it('refuses what it cannot take, saying why', () => {
    expect(parseCrt(new Uint8Array(100))).toMatchObject({ error: expect.stringMatching(/Not a C64 cartridge/) });
    expect(parseCrt(buildCrt(3, 0, 1, banks(0x8000, 1)))).toMatchObject({ error: expect.stringMatching(/type 3 is not supported/) });
    const chop = buildCrt(0, 0, 1, banks(0x8000, 1)).subarray(0, 0x40 + 0x10 + 100);
    expect(parseCrt(chop)).toMatchObject({ error: expect.stringMatching(/truncated/) });
    expect(parseCrt(buildCrt(0, 0, 1, []))).toMatchObject({ error: expect.stringMatching(/no ROM/) });
  });
});

describe('the memory map a cartridge makes', () => {
  it('shows an 8K cartridge at $8000 while LORAM and HIRAM are high, and the RAM under it otherwise', () => {
    const m = fit(buildCrt(0, 0, 1, [{ bank: 0, load: 0x8000, data: rom8k(0x5A) }]));
    expect(rd(m, 0x8000)).toBe(0x5A);
    wr(m, 0x8000, 0x77);                                 // a write reaches the RAM below
    port(m, 0x06);                                       // LORAM low: the cartridge steps out
    expect(rd(m, 0x8000)).toBe(0x77);
    m.destroy();
  });

  it('puts a 16K cartridge\'s ROMH over BASIC', () => {
    const m = fit(buildCrt(0, 0, 0, [
      { bank: 0, load: 0x8000, data: rom8k(0x11) },
      { bank: 0, load: 0xA000, data: rom8k(0x22) },
    ]));
    expect(rd(m, 0x8000)).toBe(0x11);
    expect(rd(m, 0xA000)).toBe(0x22);
    port(m, 0x06);                                       // LORAM low, HIRAM high: ROMH stays
    expect(rd(m, 0xA000)).toBe(0x22);
    expect(rd(m, 0x8000)).not.toBe(0x11);
    port(m, 0x01);                                       // HIRAM low: both gone
    expect(rd(m, 0xA000)).not.toBe(0x22);
    m.destroy();
  });

  it('runs the machine from an Ultimax cartridge alone: no RAM above $1000, ROM at $E000', () => {
    const rom = rom8k(0xEA, [[0, [0xA9, 0x07, 0x8D, 0x20, 0xD0, 0x4C, 0x05, 0xE0]], [0x1FFC, [0x00, 0xE0]]]);
    const m = fit(buildCrt(0, 1, 0, [{ bank: 0, load: 0xE000, data: rom }]));
    expect(rd(m, 0xFFFC)).toBe(0x00);
    expect(rd(m, 0x2000)).toBe(0xFF);                    // nothing there
    wr(m, 0x2000, 0x12);
    expect(rd(m, 0x2000)).toBe(0xFF);
    wr(m, 0x0400, 0x34);
    expect(rd(m, 0x0400)).toBe(0x34);                    // the first 4K is RAM
    for (let f = 0; f < 3; f++) m.tick();
    expect(m.vic.regs[0x20] & 15).toBe(7);               // it booted from the cartridge's reset vector
    m.destroy();
  });

  it('looks at ROM without side effects', () => {
    const m = fit(buildCrt(0, 0, 1, [{ bank: 0, load: 0x8000, data: rom8k(0x5A) }]));
    expect(m.memory.peekByte(0x8000)).toBe(0x5A);
    m.destroy();
  });
});

describe('bank switching', () => {
  it('Ocean: $DE00 picks the bank, and ROMH follows on the 256K board', () => {
    const m = fit(buildCrt(5, 0, 0, [...banks(0x8000, 16), ...banks(0xA000, 32).slice(16)]));
    expect(rd(m, 0x8000)).toBe(1);
    wr(m, 0xDE00, 3);
    expect(rd(m, 0x8000)).toBe(4);
    expect(rd(m, 0xA000)).toBe(20);                      // bank 16 + 3, filled 17 + 3
    wr(m, 0xDE00, 0x80 | 15);
    expect(rd(m, 0x8000)).toBe(16);
    m.destroy();
  });

  it('System 3: any access of $DE00+n selects bank n', () => {
    const m = fit(buildCrt(15, 0, 1, banks(0x8000, 64)));
    rd(m, 0xDE05);
    expect(rd(m, 0x8000)).toBe(6);
    wr(m, 0xDE20, 0);
    expect(rd(m, 0x8000)).toBe(33);
    m.destroy();
  });

  it('Dinamic: a read of $DE00+n selects bank n (a write does not)', () => {
    const m = fit(buildCrt(17, 0, 1, banks(0x8000, 16)));
    rd(m, 0xDE0A);
    expect(rd(m, 0x8000)).toBe(11);
    wr(m, 0xDE02, 0);
    expect(rd(m, 0x8000)).toBe(11);
    m.destroy();
  });

  it('Magic Desk: $DE00 picks the bank and bit 7 switches the cartridge off', () => {
    const m = fit(buildCrt(19, 0, 1, banks(0x8000, 16)));
    wr(m, 0xDE00, 4);
    expect(rd(m, 0x8000)).toBe(5);
    wr(m, 0xDE00, 0x80);
    expect(rd(m, 0x8000)).not.toBe(5);                   // RAM now
    wr(m, 0xDE00, 2);
    expect(rd(m, 0x8000)).toBe(3);                       // and back
    m.destroy();
  });

  it('Fun Play: the bank bits are scattered across $DE00, and $86 switches it off', () => {
    const m = fit(buildCrt(7, 0, 1, banks(0x8000, 16)));
    wr(m, 0xDE00, 0x08); expect(rd(m, 0x8000)).toBe(2);  // bank 1
    wr(m, 0xDE00, 0x01); expect(rd(m, 0x8000)).toBe(9);  // bank 8
    wr(m, 0xDE00, 0x39); expect(rd(m, 0x8000)).toBe(16); // bank 15
    wr(m, 0xDE00, 0x86); expect(rd(m, 0x8000)).not.toBe(16);
    m.destroy();
  });

  it('Super Games: $DF00 picks a 16K bank, switches off, and locks', () => {
    const chips: CrtChip[] = [0, 1, 2, 3].map(bank => ({ bank, load: 0x8000, data: new Uint8Array(0x4000).fill(0x10 + bank) }));
    const m = fit(buildCrt(8, 0, 0, chips));
    expect(rd(m, 0x8000)).toBe(0x10);
    wr(m, 0xDF00, 2);
    expect(rd(m, 0x8000)).toBe(0x12);
    expect(rd(m, 0xA000)).toBe(0x12);
    wr(m, 0xDF00, 0x0C);                                 // off, and locked
    expect(rd(m, 0x8000)).not.toBe(0x12);
    wr(m, 0xDF00, 0);                                    // ignored
    expect(rd(m, 0x8000)).not.toBe(0x10);
    m.destroy();
  });

  it('Simons\' BASIC: a read of $DE00 brings in ROMH, a write of 1 takes it out', () => {
    const m = fit(buildCrt(4, 0, 1, [
      { bank: 0, load: 0x8000, data: rom8k(0x31) },
      { bank: 0, load: 0xA000, data: rom8k(0x32) },
    ]));
    expect(rd(m, 0x8000)).toBe(0x31);
    expect(rd(m, 0xA000)).not.toBe(0x32);                // BASIC's
    rd(m, 0xDE00);
    expect(rd(m, 0xA000)).toBe(0x32);
    wr(m, 0xDE00, 1);
    expect(rd(m, 0xA000)).not.toBe(0x32);
    m.destroy();
  });

  it('Zaxxon: reading the lower or upper half of $8000 picks the ROMH bank', () => {
    const lo = new Uint8Array(0x1000).fill(0x41);
    const m = fit(buildCrt(18, 0, 0, [
      { bank: 0, load: 0x8000, data: lo },
      { bank: 0, load: 0xA000, data: rom8k(0x51) },
      { bank: 1, load: 0xA000, data: rom8k(0x52) },
    ]));
    rd(m, 0x8000);
    expect(rd(m, 0xA000)).toBe(0x51);
    rd(m, 0x9000);
    expect(rd(m, 0xA000)).toBe(0x52);
    rd(m, 0x8800);
    expect(rd(m, 0xA000)).toBe(0x51);
    m.destroy();
  });

  it('Epyx FastLoad: the ROM drops out after 512 cycles unless it is read, and I/O 1 brings it back', () => {
    const rom = rom8k(0x61);
    rom[0x1FFF] = 0x99;
    const m = fit(buildCrt(10, 0, 1, [{ bank: 0, load: 0x8000, data: rom }]));
    expect(rd(m, 0x8000)).toBe(0x61);
    m.cpu.tStates += 400;
    expect(rd(m, 0x8000)).toBe(0x61);                    // that read held it in
    m.cpu.tStates += 400;
    expect(rd(m, 0x8000)).toBe(0x61);
    m.cpu.tStates += 600;
    expect(rd(m, 0x8000)).not.toBe(0x61);                // let go
    expect(rd(m, 0xDF00 + 0xFF)).toBe(0x99);             // its last page shows in I/O 2
    rd(m, 0xDE00);
    expect(rd(m, 0x8000)).toBe(0x61);                    // I/O 1 discharged the capacitor
    m.destroy();
  });

  it('EasyFlash: starts in Ultimax, $DE02 picks the mode, $DE00 the bank, and I/O 2 is RAM', () => {
    const roml = banks(0x8000, 4, n => 0x20 + n);
    const romh = banks(0xA000, 4, n => 0x30 + n);
    const m = fit(buildCrt(32, 1, 0, [...roml, ...romh]));
    expect(m.memory.ultimax).toBe(true);
    expect(rd(m, 0x8000)).toBe(0x20);
    expect(rd(m, 0xE000)).toBe(0x30);
    wr(m, 0xDE00, 2);
    expect(rd(m, 0x8000)).toBe(0x22);
    expect(rd(m, 0xE000)).toBe(0x32);
    wr(m, 0xDE02, 0x07);                                 // 16K: ROMH moves to $A000
    expect(m.memory.ultimax).toBe(false);
    expect(rd(m, 0xA000)).toBe(0x32);
    wr(m, 0xDE02, 0x06);                                 // 8K: BASIC is back
    expect(rd(m, 0x8000)).toBe(0x22);
    expect(rd(m, 0xA000)).not.toBe(0x32);
    wr(m, 0xDE02, 0x04);                                 // off
    expect(rd(m, 0x8000)).not.toBe(0x22);
    wr(m, 0xDF10, 0xC3);
    expect(rd(m, 0xDF10)).toBe(0xC3);
    m.destroy();
  });
});

describe('a cartridge in the machine', () => {
  it('goes through the media service and the ROM pane\'s slot', async () => {
    const m = new C64Machine('c64', null);
    expect(m.services.media.accepts().some(t => t.ext === '.crt' && t.target === 'cartridge')).toBe(true);
    const crt = buildCrt(0, 0, 1, [{ bank: 0, load: 0x8000, data: rom8k(0x5A) }], 'GAME');
    const r = await m.services.media.mount(crt, 'game.crt');
    expect(r).toMatchObject({ ok: true, target: 'cartridge' });
    expect(m.services.roms.cartridge.name).toBe('game.crt');
    expect(rd(m, 0x8000)).toBe(0x5A);
    m.services.roms.cartridge.eject();
    expect(m.services.roms.cartridge.name).toBe('');
    expect(rd(m, 0x8000)).not.toBe(0x5A);
    expect(await m.services.media.mount(new Uint8Array(100), 'x.crt')).toMatchObject({ ok: false });
    m.destroy();
  });

  it('keeps its bank and state in a snapshot, with the cartridge itself', () => {
    const a = fit(buildCrt(5, 0, 1, banks(0x8000, 16)));
    wr(a, 0xDE00, 6);
    const w = new StateWriter();
    a.saveState(w, false);
    const b = new C64Machine('c64', null);
    b.loadState(new StateReader(w.finish()));
    expect(b.cartridge?.type).toBe('ocean');
    expect(rd(b, 0x8000)).toBe(7);
    // A snapshot of a machine without one takes the cartridge off.
    const empty = new C64Machine('c64', null);
    empty.reset();
    const w2 = new StateWriter();
    empty.saveState(w2, false);
    b.loadState(new StateReader(w2.finish()));
    expect(b.cartridge).toBeNull();
    a.destroy(); b.destroy(); empty.destroy();
  });

  it('starts over when a cartridge is put in', () => {
    const m = new C64Machine('c64', null);
    m.memory.ram[0x0400] = 0x99;
    m.mountCartridge(cartOf(buildCrt(0, 0, 1, [{ bank: 0, load: 0x8000, data: rom8k(0x5A) }])), 'a.crt');
    expect(m.memory.ram[0x0400]).not.toBe(0x99);         // a power cycle
    m.destroy();
  });
});

const basic = romImage('basic-901226-01.rom');
const kernal = romImage('kernal-901227-03.rom');
const chargen = romImage('chargen-901225-01.rom');

describe.skipIf(!basic || !kernal || !chargen)('a cartridge with the real KERNAL', () => {
  it('autostarts through the CBM80 signature', () => {
    const rom = rom8k(0xEA, [
      [0, [0x09, 0x80, 0x09, 0x80]],                      // cold and warm start: $8009
      [4, [0xC3, 0xC2, 0xCD, 0x38, 0x30]],                // "CBM80"
      [9, [0xA9, 0xAA, 0x8D, 0x00, 0xC0, 0x4C, 0x0E, 0x80]],   // LDA #$AA : STA $C000 : JMP *
    ]);
    const all = new Uint8Array(0x5000);
    all.set(basic!, 0);
    all.set(kernal!, 0x2000);
    all.set(chargen!, 0x4000);
    const m = new C64Machine('c64', null);
    m.loadROM(all);
    m.setCartridge(cartOf(buildCrt(0, 0, 1, [{ bank: 0, load: 0x8000, data: rom }])));
    m.reset();
    for (let f = 0; f < 100; f++) m.tick();
    expect(m.memory.ram[0xC000]).toBe(0xAA);
    expect(m.ocrScreenForMcp()).not.toMatch(/READY\./);
    m.destroy();
  });
});
