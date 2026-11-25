/**
 * Plus/4 cartridges: ROM on the expansion port, in the two 16K banks the TED
 * selects (`$8000-$BFFF` low and `$C000-$FFFF` high, chosen at `$FDD0-$FDDF`).
 *
 * The files come two ways:
 *
 *  - VICE's `.crt`: a "C64 CARTRIDGE " header then CHIP packets. The header's
 *    hardware type names the board:
 *
 *      0  a plain ROM: bank 0 is the low 16K, bank 1 the high 16K
 *      1  the c264 "magic cart": 128K-2MB, bank chosen at `$FDFE`
 *      2  the Plus/4 multi cart: 2MB or 4MB, low and high halves, bank at `$FDA0`
 *      3  the JACINT 1MB: 64 banks at `$8000-$BFFF`, bank chosen at `$FE00`
 *      4  the Speedy freezer, which is not emulated
 *
 *    On the banked boards every chip is a 16K bank loaded at `$8000` (the
 *    multi cart's high-half chips load at `$C000`).
 *  - A raw image: 16K, 32K or 64K of ROM, placed from `$8000` upward, which is
 *    how the Plus/4 cartridge files in the wild are usually shipped (`.bin`).
 *
 * The ROMs are 16K banks; a smaller image is padded with `$FF`, which is what
 * an empty bank reads as.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

export type Plus4CartType = 'normal' | 'magic' | 'multi' | 'jacint';

/** The expansion port's view of a cartridge's ROMs. */
export interface Plus4CartSource {
  readLow(addr: number): number;
  readHigh(addr: number): number;
}

/**
 * One cartridge's ROM and its bank register. `normal` reads the two 16K banks
 * directly; the banked boards map 16K windows of a larger image.
 */
export class Plus4CartridgeMapper implements Plus4CartSource {
  /** The bank the board's register selects (power-on 0). */
  bank = 0;

  constructor(
    readonly type: Plus4CartType,
    /** The whole image for a banked board, empty for a plain one. */
    readonly rom: Uint8Array,
    /** The plain board's two banks. */
    readonly low: Uint8Array | null,
    readonly high: Uint8Array | null,
  ) {}

  reset(): void { this.bank = 0; }

  readLow(addr: number): number {
    if (this.type === 'normal') return this.low ? this.low[addr & 0x3FFF] : 0xFF;
    if (this.type === 'multi') {
      const half = this.rom.length >> 1;
      return this.rom[(((addr & 0x3FFF) + this.bank * 0x4000) & (half - 1))];
    }
    return this.rom[(((addr & 0x3FFF) + this.bank * 0x4000) & (this.rom.length - 1))];
  }

  readHigh(addr: number): number {
    if (this.type === 'normal') return this.high ? this.high[addr & 0x3FFF] : 0xFF;
    if (this.type === 'multi') {
      const half = this.rom.length >> 1;
      return this.rom[half + (((addr & 0x3FFF) + this.bank * 0x4000) & (half - 1))];
    }
    return 0xFF;   // magic cart and JACINT answer only in the low half
  }

  /** The board's bank register, where it has one. */
  writeRegister(addr: number, value: number): boolean {
    if (this.type === 'jacint' && addr === 0xFE00) { this.bank = value; return true; }
    if (this.type === 'magic' && addr === 0xFDFE) { this.bank = value; return true; }
    if (this.type === 'multi' && addr === 0xFDA0) { this.bank = value; return true; }
    return false;
  }
}

export interface Plus4Cartridge {
  readonly name: string;
  /** The bank the $8000 window shows (a plain cartridge's low bank). */
  readonly low: Uint8Array | null;
  /** The bank the $C000 window shows, where the board has one. */
  readonly high: Uint8Array | null;
  readonly mapper: Plus4CartridgeMapper;
}

/** Build a cartridge from its parts (the parser and the snapshot reader). */
export function makePlus4Cartridge(
  name: string, type: Plus4CartType, low: Uint8Array | null, high: Uint8Array | null,
  rom: Uint8Array, bank = 0,
): Plus4Cartridge {
  const mapper = new Plus4CartridgeMapper(type, rom, low, high);
  mapper.bank = bank;
  return { name, low, high, mapper };
}

/** The extensions a Plus/4 cartridge comes in. */
export const PLUS4_CART_PATTERN = /\.(crt|bin)$/i;

const BANK = 0x4000;

/** Place `bytes` at CPU address `addr`, in the bank the address falls in. */
function place(low: Uint8Array | null, high: Uint8Array | null, addr: number, bytes: Uint8Array):
  { low: Uint8Array | null; high: Uint8Array | null } | string {
  const end = addr + bytes.length;
  if (addr < 0x8000 || end > 0x10000) return `ROM at $${addr.toString(16).toUpperCase()} is outside the cartridge banks`;
  const lowOut = low ? low.slice() : new Uint8Array(BANK).fill(0xFF);
  const highOut = high ? high.slice() : new Uint8Array(BANK).fill(0xFF);
  for (let a = addr; a < end; a++) {
    if (a < 0xC000) lowOut[a & 0x3FFF] = bytes[a - addr];
    else highOut[a & 0x3FFF] = bytes[a - addr];
  }
  return { low: lowOut, high: highOut };
}

interface Chip { bank: number; addr: number; size: number; bytes: Uint8Array }

function parseCrt(data: Uint8Array, name: string): Plus4Cartridge | { error: string } {
  const be32 = (at: number) => ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
  const be16 = (at: number) => (data[at] << 8) | data[at + 1];
  if (data.length < 0x40) return { error: 'the .crt file is cut short' };
  if (String.fromCharCode(...data.subarray(0, 13)) !== 'C64 CARTRIDGE') return { error: 'not a .crt (no "C64 CARTRIDGE" header)' };
  const headerLen = be32(0x10);
  const type = be16(0x16);
  const chips: Chip[] = [];
  let at = Math.max(0x40, headerLen);
  while (at + 0x10 <= data.length) {
    if (String.fromCharCode(...data.subarray(at, at + 4)) !== 'CHIP') return { error: 'a CHIP packet of the .crt is damaged' };
    const len = be32(at + 4);
    const size = be16(at + 0x0E);
    if (len < 0x10 || at + 0x10 + size > data.length) return { error: 'a CHIP packet of the .crt is cut short' };
    chips.push({
      bank: be16(at + 8), addr: be16(at + 0x0C), size,
      bytes: data.subarray(at + 0x10, at + 0x10 + size),
    });
    at += len;
  }
  if (chips.length === 0) return { error: 'the .crt has no ROM in it' };
  const base = name.replace(/\.[^.]+$/, '');

  switch (type) {
    case 0: {
      // The plain board: bank 0 is the low half, bank 1 the high half.
      let low: Uint8Array | null = null;
      let high: Uint8Array | null = null;
      for (const chip of chips) {
        const target = chip.bank === 0 ? 0x8000 : 0xC000;
        if (chip.addr !== target) return { error: `a CHIP of the .crt loads at $${chip.addr.toString(16).toUpperCase()} in bank ${chip.bank}` };
        const placed = place(low, high, target, chip.bytes);
        if (typeof placed === 'string') return { error: placed };
        low = placed.low; high = placed.high;
      }
      return makePlus4Cartridge(base, 'normal', low, high, new Uint8Array(0));
    }
    case 1: {
      // c264 magic cart: 8/16/32/64/128 banks of 16K at $8000.
      const banks = chips.length;
      if (![8, 16, 32, 64, 128].includes(banks)) return { error: `a magic cart is 8-128 banks, not ${banks}` };
      if (chips.some(c => c.addr !== 0x8000 || c.size !== BANK || c.bank >= 128)) return { error: 'a magic cart CHIP must be 16K at $8000 in bank 0-127' };
      const rom = new Uint8Array(banks * BANK).fill(0xFF);
      for (const chip of chips) rom.set(chip.bytes, chip.bank * BANK);
      return makePlus4Cartridge(base, 'magic', rom.slice(0, BANK), null, rom);
    }
    case 2: {
      // The multi cart: 128 or 256 chips, the first half low and the second high.
      const total = chips.length;
      if (total !== 128 && total !== 256) return { error: `a multi cart is 128 or 256 banks, not ${total}` };
      const half = (total >> 1) * BANK;
      const rom = new Uint8Array(half * 2).fill(0xFF);
      for (const chip of chips) {
        if (chip.size !== BANK || chip.bank >= 128 || (chip.addr !== 0x8000 && chip.addr !== 0xC000)) {
          return { error: 'a multi cart CHIP must be 16K at $8000 or $C000 in bank 0-127' };
        }
        rom.set(chip.bytes, (chip.addr === 0x8000 ? 0 : half) + chip.bank * BANK);
      }
      return makePlus4Cartridge(base, 'multi', rom.slice(0, BANK), rom.slice(half, half + BANK), rom);
    }
    case 3: {
      // The JACINT 1MB: 64 banks of 16K at $8000.
      if (chips.length !== 64) return { error: `a 1MB cartridge is 64 banks, not ${chips.length}` };
      if (chips.some(c => c.addr !== 0x8000 || c.size !== BANK || c.bank >= 64)) return { error: 'a 1MB cartridge CHIP must be 16K at $8000 in bank 0-63' };
      const rom = new Uint8Array(BANK * 64);
      for (const chip of chips) rom.set(chip.bytes, chip.bank * BANK);
      return makePlus4Cartridge(base, 'jacint', rom.slice(0, BANK), null, rom);
    }
    case 4:
      return { error: 'the Speedy freezer cartridge is not emulated yet (hardware type 4)' };
    default:
      return { error: `.crt hardware type ${type} is not a Plus/4 cartridge` };
  }
}

/**
 * Read a cartridge file. Returns the cartridge, or why the file is not one.
 */
export function parsePlus4Cartridge(data: Uint8Array, name: string): { cart: Plus4Cartridge } | { error: string } {
  const base = name.replace(/^.*[\\/]/, '');
  if (/\.crt$/i.test(base) || String.fromCharCode(...data.subarray(0, 13)) === 'C64 CARTRIDGE') {
    const cart = parseCrt(data, base);
    return 'error' in cart ? cart : { cart };
  }
  // A raw image: 16K, 32K or 64K from `$8000` up.
  if (data.length === 0 || data.length > 0x8000) {
    return { error: `a cartridge ROM is 16K, 32K or 64K, not ${data.length} bytes` };
  }
  const image = new Uint8Array(0x8000).fill(0xFF);
  image.set(data.subarray(0, 0x8000));
  const low = image.subarray(0, 0x4000).slice();
  const high = image.subarray(0x4000, 0x8000).slice();
  return { cart: makePlus4Cartridge(base.replace(/\.[^.]+$/, ''), 'normal', low, high, new Uint8Array(0)) };
}

/** Whether a `.bin` is a cartridge rather than something else: any ROM image of
 *  the right size that does not look like a program with a load address. */
export function isCartridgeBinary(data: Uint8Array): boolean {
  if (data.length !== 0x4000 && data.length !== 0x8000) return false;
  // A `.prg` starts with a load address in $0000-$FFFF; a ROM does not begin
  // with a plausible pair both ways round, so leave that to the media service.
  return true;
}

export function saveCartridge(w: StateWriter, cart: Plus4Cartridge | null): void {
  w.bool(cart !== null);
  if (!cart) return;
  w.str(cart.name);
  w.str(cart.mapper.type);
  w.u8(cart.mapper.bank);
  w.raw(cart.mapper.rom);
  w.bool(cart.low !== null);
  if (cart.low) w.raw(cart.low);
  w.bool(cart.high !== null);
  if (cart.high) w.raw(cart.high);
}

export function loadCartridge(r: StateReader): Plus4Cartridge | null {
  if (!r.bool()) return null;
  const name = r.str();
  const type = r.str() as Plus4CartType;
  const bank = r.u8();
  const rom = new Uint8Array(0);
  r.rawInto(rom);
  let low: Uint8Array | null = null;
  let high: Uint8Array | null = null;
  if (r.bool()) { low = new Uint8Array(0x4000); r.rawInto(low); }
  if (r.bool()) { high = new Uint8Array(0x4000); r.rawInto(high); }
  return makePlus4Cartridge(name, type, low, high, rom, bank);
}
