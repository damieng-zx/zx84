/**
 * VIC-20 cartridges: the file forms they come in, where their ROM lands, how
 * it sits over RAM, and that a snapshot carries them.
 *
 * From the hardware: a cartridge is ROM in the expansion port's 8K blocks
 * (BLK1 $2000, BLK2 $4000, BLK3 $6000, BLK5 $A000); the KERNAL autostarts
 * one with "A0CBM" ($41 $30 $C3 $C2 $CD) at $A004 through the vector at
 * $A000. From VICE's .crt: a "VIC20 CARTRIDGE " header (header length at
 * $10, hardware type at $16, big-endian) and CHIP packets (length at +4,
 * load address at +$0C, size at +$0E, ROM from +$10).
 */

import { describe, it, expect } from 'vitest';
import { hasAutostart, isCartridgePrg, parseVic20Cartridge } from '@/machines/vic20/cartridge.ts';
import { Vic20Memory, VIC20_NO_EXPANSION } from '@/machines/vic20/memory.ts';
import { expectExactFromFile, romImage } from '../snapshot/native-state-helpers.ts';
import { firmware, machine } from './firmware.ts';

/** `size` bytes of ROM, each byte its offset's low byte plus `seed`, with the
 *  autostart signature when `autostart`. */
function rom(size: number, seed = 0, autostart = false): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i + seed) & 0xFF;
  if (autostart) out.set([0x41, 0x30, 0xC3, 0xC2, 0xCD], 4);
  return out;
}

const withAddress = (addr: number, bytes: Uint8Array) => Uint8Array.from([addr & 0xFF, addr >> 8, ...bytes]);

function crt(type: number, chips: { addr: number; data: Uint8Array }[]): Uint8Array {
  const parts: number[] = [];
  const header = new Array<number>(0x40).fill(0);
  'VIC20 CARTRIDGE '.split('').forEach((c, i) => { header[i] = c.charCodeAt(0); });
  header[0x13] = 0x40;                 // header length, big-endian
  header[0x14] = 1;                    // version 1.0
  header[0x16] = type >> 8; header[0x17] = type & 0xFF;
  parts.push(...header);
  for (const chip of chips) {
    const len = 0x10 + chip.data.length;
    parts.push(0x43, 0x48, 0x49, 0x50, len >>> 24, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF,
      0, 0, 0, 0, chip.addr >> 8, chip.addr & 0xFF, chip.data.length >> 8, chip.data.length & 0xFF, ...chip.data);
  }
  return Uint8Array.from(parts);
}

function ok(r: ReturnType<typeof parseVic20Cartridge>) {
  if ('error' in r) throw new Error(r.error);
  return r.cart;
}

describe('VIC-20 cartridge files', () => {
  it('places a load-address image at its address', () => {
    const cart = ok(parseVic20Cartridge(withAddress(0xA000, rom(0x2000)), 'game.prg'));
    expect([...cart.blocks.keys()]).toEqual([5]);
    expect(cart.blocks.get(5)![0x1234]).toBe(0x34);
    expect(cart.name).toBe('game');
  });

  it('spreads a 16K image at $2000 over BLK1 and BLK2', () => {
    const cart = ok(parseVic20Cartridge(withAddress(0x2000, rom(0x4000, 7)), 'big.20'));
    expect([...cart.blocks.keys()].sort()).toEqual([1, 2]);
    expect(cart.blocks.get(2)![0]).toBe((0x2000 + 7) & 0xFF);
  });

  it('repeats a 4K raw image in the top half of its block', () => {
    const cart = ok(parseVic20Cartridge(rom(0x1000, 3), 'small.a0'));
    const blk5 = cart.blocks.get(5)!;
    expect(blk5[0x1000]).toBe(blk5[0x0000]);
    expect(blk5[0x1FFF]).toBe(blk5[0x0FFF]);
  });

  it('places raw images by their extension', () => {
    expect([...ok(parseVic20Cartridge(rom(0x2000), 'x.60')).blocks.keys()]).toEqual([3]);
    expect([...ok(parseVic20Cartridge(rom(0x2000), 'x.40')).blocks.keys()]).toEqual([2]);
  });

  it('reads the CHIP packets of a generic .crt', () => {
    const cart = ok(parseVic20Cartridge(crt(0, [
      { addr: 0x2000, data: rom(0x2000, 1) },
      { addr: 0xA000, data: rom(0x2000, 2, true) },
    ]), 'two.crt'));
    expect([...cart.blocks.keys()].sort()).toEqual([1, 5]);
    expect(hasAutostart(cart.blocks.get(5)!)).toBe(true);
  });

  it('refuses what it cannot place', () => {
    expect('error' in parseVic20Cartridge(crt(5, [{ addr: 0xA000, data: rom(0x2000) }]), 'banked.crt')).toBe(true);
    expect('error' in parseVic20Cartridge(rom(0x2000), 'c64.crt')).toBe(true);
    expect('error' in parseVic20Cartridge(rom(0x4000), 'huge.a0')).toBe(true);
    expect('error' in parseVic20Cartridge(rom(0x2000), 'mystery.bin')).toBe(true);
    // ROM aimed at $8000 is not in a cartridge block.
    expect('error' in parseVic20Cartridge(crt(0, [{ addr: 0x8000, data: rom(0x1000) }]), 'bad.crt')).toBe(true);
  });

  it('tells a cartridge .prg from a program', () => {
    expect(isCartridgePrg(withAddress(0xA000, rom(0x2000, 0, true)))).toBe(true);
    expect(isCartridgePrg(withAddress(0xA000, rom(0x2000)))).toBe(false);
    expect(isCartridgePrg(withAddress(0x1001, rom(0x100, 0, true)))).toBe(false);
  });
});

describe('VIC-20 cartridge ROM', () => {
  it('answers in its block ahead of expansion RAM, and ignores writes', () => {
    const mem = new Vic20Memory();
    mem.setExpansion({ ...VIC20_NO_EXPANSION, blk5: true });
    mem.setCartridge(ok(parseVic20Cartridge(withAddress(0xA000, rom(0x2000, 0x10)), 'c.prg')));
    expect(mem.readByte(0xA000)).toBe(0x10);
    mem.writeByte(0xA000, 0x99);
    expect(mem.readByte(0xA000)).toBe(0x10);
    mem.setCartridge(null);
    expect(mem.readByte(0xA000), 'the RAM beneath took the write').toBe(0x99);
  });

  it('is not on the VIC\'s bus', () => {
    const mem = new Vic20Memory();
    mem.setCartridge(ok(parseVic20Cartridge(withAddress(0x2000, rom(0x2000)), 'c.20')));
    expect(mem.vicRead(0x2000), 'VIC $2000 is CPU $0000, board RAM').toBe(mem.ram[0x0000]);
  });

  it('goes in through a dropped file, resetting the machine', async () => {
    const m = machine(firmware());
    for (let f = 0; f < 5; f++) m.tick();
    const r = await m.services.media.mount(withAddress(0xA000, rom(0x2000, 0, true)), 'game.prg');
    expect(r.ok, r.message).toBe(true);
    expect(r.target).toBe('cartridge');
    expect(m.services.roms.cartridge!.name).toBe('game.prg');
    expect(m.memory.readByte(0xA004)).toBe(0x41);
    m.services.roms.cartridge!.eject();
    expect(m.memory.cart).toBeNull();
    m.destroy();
  });

  it('is carried by a snapshot, and taken out by one without it', async () => {
    const rom0 = firmware();
    const m = machine(rom0);
    m.mountCartridge(ok(parseVic20Cartridge(withAddress(0xA000, rom(0x2000, 0x22)), 'c.prg')), 'c.prg');
    for (let f = 0; f < 3; f++) m.tick();
    const fresh = machine(rom0);
    await expectExactFromFile(m, fresh, '.vic20state', 4);
    expect(fresh.memory.readByte(0xA000)).toBe(0x22);

    const plain = machine(rom0);
    plain.tick();
    const file = await plain.services.snapshots!.save('.vic20state');
    expect((await fresh.services.snapshots!.apply(file, 'p.vic20state')).ok).toBe(true);
    expect(fresh.memory.cart).toBeNull();
  });
});

const basic = romImage('basic-901486-01.rom');
const kernalPal = romImage('kernal-901486-07.rom');
const chargen = romImage('characters-901460-03.rom');

describe.skipIf(!basic || !kernalPal || !chargen)('VIC-20 cartridge with the Commodore ROMs', () => {
  it('is started by the KERNAL through its autostart signature', () => {
    const system = new Uint8Array(0x5000);
    system.set(basic!, 0);
    system.set(kernalPal!, 0x2000);
    system.set(chargen!, 0x4000);
    // $A000: cold and warm start vectors to $A009, "A0CBM", then
    // LDA #$42 / STA $1000 / JMP *.
    const code = rom(0x2000);
    code.fill(0xEA);
    code.set([0x09, 0xA0, 0x09, 0xA0, 0x41, 0x30, 0xC3, 0xC2, 0xCD], 0);
    code.set([0xA9, 0x42, 0x8D, 0x00, 0x10, 0x4C, 0x0E, 0xA0], 9);
    const m = machine(system);
    m.mountCartridge(ok(parseVic20Cartridge(withAddress(0xA000, code), 'auto.prg')), 'auto.prg');
    for (let f = 0; f < 5; f++) m.tick();
    expect(m.memory.ram[0x1000]).toBe(0x42);
    expect(m.cpu.pc).toBeGreaterThanOrEqual(0xA00E);
    expect(m.cpu.pc).toBeLessThan(0xA011);
  });
});
