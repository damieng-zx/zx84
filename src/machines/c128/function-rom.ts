/**
 * A Commodore 128 function ROM: what the 128 itself runs from, as opposed to a
 * 64 cartridge. The MMU's configuration register can put an external function
 * ROM (the expansion port's) over $8000-$BFFF (bits 3-2 = 10) and over
 * $C000-$FFFF (bits 5-4 = 10); an internal one (the empty socket on the board)
 * with 01. Each is 16K at $8000 and 16K at $C000, 32K in all.
 *
 * Software finds a function ROM by its header: at the start of the image
 * `JMP cold-start`, `JMP warm-start`, a type byte, then the letters `CBM`. The
 * KERNAL looks for that at start-up; that is the cartridge's business, not the
 * memory map's.
 *
 * Files: a `.crt` with the signature `C128 CARTRIDGE` (VICE's format, hardware
 * type at $16), or a bare image of 8K, 16K or 32K (the low half first). A
 * cartridge leaves /GAME and /EXROM high, so the BIOS does not take it for a
 * 64 cartridge. The boards, by the VICE manual's list of the 128's own:
 *
 *   0 generic      16K at $8000 and 16K at $C000, no banks
 *   1 Warpspeed128 16K at $8000; the part at $9E00-$9FFF shows again at $DE00-$DFFF
 *   2 Partner 128  16K at $8000 and 8K of RAM: a 128-byte window at $DE00-$DE7F onto
 *                  one of 64 blocks, picked by a write to $DE80; $DE80-$DEFF shows
 *                  the ROM's $9E80-$9EFF
 *   4 Magic Desk   16K banks at $8000, up to 64: the low six bits of a write to $DE00
 *                  pick the bank
 *
 * Comal 80 (3) and Gmod2-C128 (5) are refused: the manual gives no layout for
 * their registers.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { isCrt, parseCrt, type C64Cartridge } from '@/machines/shared/cbm/cartridge.ts';

const SIGNATURE = 'C128 CARTRIDGE';
const HALF = 0x4000;
const BANKS = 64;

export type C128CartType = 'generic' | 'warpspeed' | 'partner' | 'magicdesk';

export const C128_CART_TYPE_NAMES: Readonly<Record<C128CartType, string>> = {
  generic: 'Generic', warpspeed: 'Warpspeed128', partner: 'Partner 128', magicdesk: 'Magic Desk 128',
};

/** The `.crt` hardware types the 128 list has, and the ones refused with their names. */
const HW_TYPES: Readonly<Record<number, C128CartType>> = { 0: 'generic', 1: 'warpspeed', 2: 'partner', 4: 'magicdesk' };
const HW_REFUSED: Readonly<Record<number, string>> = { 3: 'Comal 80', 5: 'Gmod2-C128' };

const TYPE_IDS: readonly C128CartType[] = ['generic', 'warpspeed', 'partner', 'magicdesk'];

export type C128FunctionRomParse = { rom: C128FunctionRom } | { error: string };

const be16 = (d: Uint8Array, o: number): number => (d[o] << 8) | d[o + 1];
const be32 = (d: Uint8Array, o: number): number => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

/** `data` looks like a Commodore 128 `.crt` file. */
export function isC128Crt(data: Uint8Array): boolean {
  if (data.length < 0x40) return false;
  for (let i = 0; i < SIGNATURE.length; i++) if (data[i] !== SIGNATURE.charCodeAt(i)) return false;
  return true;
}

export class C128FunctionRom {
  /** The 16K images for $8000-$BFFF by bank number; one bank unless the board switches them. */
  readonly lowBanks: (Uint8Array | undefined)[] = [];
  /** $C000-$FFFF; $FF where the image has nothing. */
  readonly high = new Uint8Array(HALF).fill(0xFF);
  /** Partner 128's 8K of RAM, as 64 blocks of 128 bytes. */
  readonly ram = new Uint8Array(0x2000);
  /** The bank at $8000, and Partner's block in the $DE00 window. */
  bank = 0;
  ramBlock = 0;

  constructor(readonly name: string, readonly type: C128CartType = 'generic') {
    this.bankAt(0);
  }

  /** The 16K bank `n` for filling, made (all $FF) if it is not there. */
  bankAt(n: number): Uint8Array {
    return this.lowBanks[n] ?? (this.lowBanks[n] = new Uint8Array(HALF).fill(0xFF));
  }

  /** $8000-$BFFF of bank 0. */
  get low(): Uint8Array { return this.bankAt(0); }

  /** Power-up: bank 0 and the first RAM block (the RAM itself keeps what it held). */
  reset(): void {
    this.bank = 0;
    this.ramBlock = 0;
  }

  /** The byte at a CPU address in $8000-$FFFF. */
  byte(addr: number): number {
    return addr < 0xC000 ? (this.lowBanks[this.bank]?.[addr - 0x8000] ?? 0xFF) : this.high[addr - 0xC000];
  }

  /** The ROM seen in the I/O areas, where the board mirrors a part of it, or -1. */
  private mirror(addr: number): number {
    if (this.type === 'warpspeed' && addr >= 0xDE00 && addr <= 0xDFFF) return this.byte(0x9E00 + (addr - 0xDE00));
    if (this.type === 'partner' && addr >= 0xDE80 && addr <= 0xDEFF) return this.byte(0x9E80 + (addr - 0xDE80));
    return -1;
  }

  /** A read of I/O 1 ($DE00-$DEFF) or I/O 2 ($DF00-$DFFF). */
  ioRead(addr: number): number {
    const m = this.mirror(addr);
    if (m >= 0) return m;
    if (this.type === 'partner' && addr >= 0xDE00 && addr <= 0xDE7F) return this.ram[(this.ramBlock << 7) | (addr & 0x7F)];
    return 0xFF;
  }

  ioWrite(addr: number, value: number): void {
    const v = value & 0xFF;
    if (this.type === 'magicdesk' && addr === 0xDE00) this.bank = v & (BANKS - 1);
    else if (this.type === 'partner') {
      if (addr >= 0xDE00 && addr <= 0xDE7F) this.ram[(this.ramBlock << 7) | (addr & 0x7F)] = v;
      else if (addr === 0xDE80) this.ramBlock = v & 0x3F;
    }
  }

  /** What the debugger shows about it. */
  describe(): string[] {
    const used = (a: Uint8Array | undefined): string => (a && a.some(b => b !== 0xFF) ? '16K' : 'empty');
    const out = [`${C128_CART_TYPE_NAMES[this.type]}: $8000-$BFFF ${used(this.lowBanks[this.bank])}   $C000-$FFFF ${used(this.high)}`];
    if (this.type === 'magicdesk') out.push(`bank ${this.bank} (of ${this.lowBanks.reduce((n, b, i) => (b ? i + 1 : n), 0)})`);
    if (this.type === 'partner') out.push(`RAM block ${this.ramBlock} (of 64) in $DE00-$DE7F`);
    return out;
  }

  saveState(w: StateWriter): void {
    w.str(this.name);
    w.u8(TYPE_IDS.indexOf(this.type));
    w.u8(this.bank); w.u8(this.ramBlock);
    w.raw(this.ram);
    w.raw(this.high);
    const present = this.lowBanks.flatMap((b, i) => (b ? [i] : []));
    w.u8(present.length);
    for (const i of present) { w.u8(i); w.raw(this.lowBanks[i]!); }
  }

  static loadState(r: StateReader): C128FunctionRom {
    const name = r.str();
    const rom = new C128FunctionRom(name, TYPE_IDS[r.u8()] ?? 'generic');
    rom.bank = r.u8(); rom.ramBlock = r.u8();
    r.rawInto(rom.ram);
    r.rawInto(rom.high);
    rom.lowBanks.length = 0;
    for (let n = r.u8(); n > 0; n--) { const i = r.u8(); r.rawInto(rom.bankAt(i)); }
    if (rom.lowBanks.length === 0) rom.bankAt(0);
    return rom;
  }
}

/** Read a Commodore 128 `.crt` file. */
export function parseC128Crt(data: Uint8Array): C128FunctionRomParse {
  if (!isC128Crt(data)) return { error: 'Not a C128 cartridge file (.crt)' };
  const headerLen = be32(data, 0x10);
  const hw = be16(data, 0x16);
  const type = HW_TYPES[hw];
  if (!type) {
    return { error: HW_REFUSED[hw] ? `The ${HW_REFUSED[hw]} cartridge is not supported (its banking is undocumented)` : `C128 cartridge hardware type ${hw} is not supported` };
  }
  let name = '';
  for (let i = 0x20; i < 0x40 && data[i] !== 0; i++) name += String.fromCharCode(data[i]);
  const rom = new C128FunctionRom(name, type);
  const banked = type === 'magicdesk';
  let at = Math.max(headerLen, 0x40);
  let chips = 0;
  while (at + 0x10 <= data.length) {
    if (String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]) !== 'CHIP') {
      return { error: `Cartridge file is damaged (no CHIP packet at ${at})` };
    }
    const total = be32(data, at + 4);
    const bank = be16(data, at + 10);
    const load = be16(data, at + 12);
    const size = be16(data, at + 14);
    if (total < 0x10 || at + 0x10 + size > data.length) return { error: 'Cartridge file is truncated' };
    if (bank >= (banked ? BANKS : 1)) {
      return { error: banked ? `Cartridge bank ${bank} is out of range (0-${BANKS - 1})` : `A ${C128_CART_TYPE_NAMES[type]} cartridge has no banks (chip in bank ${bank})` };
    }
    if (load < 0x8000 || load + size > 0x10000 || (load < 0xC000 && load + size > 0xC000)) {
      return { error: `Cartridge chip loads at $${load.toString(16).toUpperCase()}, which is not a function ROM address` };
    }
    if (load >= 0xC000 && type !== 'generic') {
      return { error: `A ${C128_CART_TYPE_NAMES[type]} cartridge has nothing at $C000` };
    }
    if (be16(data, at + 8) !== 1) {                         // 1 is RAM: nothing to load
      const half = load < 0xC000 ? rom.bankAt(bank) : rom.high;
      half.set(data.subarray(at + 0x10, at + 0x10 + size), load & (HALF - 1));
      chips++;
    }
    at += Math.max(total, 0x10);
  }
  if (chips === 0) return { error: 'Cartridge file holds no ROM' };
  return { rom };
}

export type C128CartridgeParse = { cart: C64Cartridge } | { rom: C128FunctionRom } | { error: string };

/** What a file for the 128's expansion port is: a 64 cartridge (`C64 CARTRIDGE`
 *  `.crt`), a 128 one (`C128 CARTRIDGE`) or, by its size, a bare function ROM. */
export function parseC128Cartridge(data: Uint8Array, name: string): C128CartridgeParse {
  if (isCrt(data)) return parseCrt(data);
  if (isC128Crt(data)) return parseC128Crt(data);
  if (/\.crt$/i.test(name)) return { error: 'Not a cartridge file (.crt)' };
  return parseFunctionRomImage(data, name);
}

/** A bare function ROM image: 8K or 16K for $8000, 32K for both halves. */
export function parseFunctionRomImage(data: Uint8Array, name: string): C128FunctionRomParse {
  if (data.length !== 0x2000 && data.length !== 0x4000 && data.length !== 0x8000) {
    return { error: 'A bare function ROM is 8K, 16K or 32K' };
  }
  const rom = new C128FunctionRom(name);
  rom.low.set(data.subarray(0, HALF));
  if (data.length > HALF) rom.high.set(data.subarray(HALF));
  return { rom };
}
