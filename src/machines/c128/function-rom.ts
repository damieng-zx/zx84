/**
 * A Commodore 128 function ROM: what the 128 itself runs from, as opposed to a
 * 64 cartridge. The MMU's configuration register can put an external function
 * ROM (the expansion port's) over $8000-$BFFF (bits 3-2 = 10) and over
 * $C000-$FFFF (bits 5-4 = 10); an internal one (the empty socket on the board)
 * with 01. Each is 16K at $8000 and 16K at $C000, 32K in all.
 *
 * Software finds a function ROM by its header: at the start of the image
 * `JMP cold-start`, `JMP warm-start`, a type byte, then the letters `CBM`. The
 * KERNAL looks for that at start-up, in the external $8000, external $C000,
 * internal $8000 and internal $C000 slots in that order; that is the
 * cartridge's business, not the memory map's.
 *
 * Files: a `.crt` with the signature `C128 CARTRIDGE` (VICE's format, hardware
 * type at $16), or a bare image of 8K, 16K or 32K (the low half first). A
 * cartridge leaves /GAME and /EXROM high, so the BIOS does not take it for a
 * 64 cartridge. A short image is mirrored, as the boards' address decoding
 * does: an 8K chip fills its 16K half twice, and a bare 16K file shows at both
 * $8000 and $C000 (the KERNAL scans both, and with the ROM in the $C000 slot
 * the vectors at $FFFA come from it). The boards, from VICE's source, MAME's
 * drivers and the real KERNAL (none of them run against a real banked image):
 *
 *   0 generic      16K at $8000 and 16K at $C000, no banks
 *   1 Warpspeed128 16K at $8000, copied to $C000; the part at $9E00-$9FFF shows
 *                  again at $DE00-$DFFF
 *   2 Partner 128  16K at $8000 (and $C000) and 8K of RAM: a 128-byte window at
 *                  $DE00-$DE7F onto one of 64 blocks, picked by a write to
 *                  $DE80-$DEFF; $DE80-$DEFF shows the ROM's $9E80-$9EFF. (The real
 *                  board also snoops the VDC and can freeze the vectors: not here.)
 *   3 Comal 80     96K as six 16K banks on ROMH only ($C000-$FFFF, $8000 is
 *                  empty); a write to $DE00-$DEFF picks one, a read gives the
 *                  register back
 *   4 Magic Desk   16K banks at $8000, up to 64: the low bits of a write to
 *                  anywhere in $DE00-$DEFF pick the bank (the mask is the next
 *                  power of two of the banks loaded, so a short image mirrors)
 *
 * Gmod2-C128 (5, 512K of flash and a serial EEPROM) is refused.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { isCrt, parseCrt, type C64Cartridge } from '@/machines/shared/cbm/cartridge.ts';

const SIGNATURE = 'C128 CARTRIDGE';
const HALF = 0x4000;
const QUARTER = 0x2000;
const BANKS = 64;
const COMAL_BANKS = 6;

export type C128CartType = 'generic' | 'warpspeed' | 'partner' | 'magicdesk' | 'comal';

export const C128_CART_TYPE_NAMES: Readonly<Record<C128CartType, string>> = {
  generic: 'Generic', warpspeed: 'Warpspeed128', partner: 'Partner 128', magicdesk: 'Magic Desk 128', comal: 'Comal 80',
};

/** The `.crt` hardware types the 128 list has, and the ones refused with their names. */
const HW_TYPES: Readonly<Record<number, C128CartType>> = { 0: 'generic', 1: 'warpspeed', 2: 'partner', 3: 'comal', 4: 'magicdesk' };
const HW_REFUSED: Readonly<Record<number, string>> = { 5: 'Gmod2-C128' };

/** Snapshot ids: new boards go on the end. */
const TYPE_IDS: readonly C128CartType[] = ['generic', 'warpspeed', 'partner', 'magicdesk', 'comal'];

export type C128FunctionRomParse = { rom: C128FunctionRom } | { error: string };

const be16 = (d: Uint8Array, o: number): number => (d[o] << 8) | d[o + 1];
const be32 = (d: Uint8Array, o: number): number => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

/** The smallest power of two that is at least `n`. */
const roundUpPow2 = (n: number): number => { let p = 1; while (p < n) p <<= 1; return p; };

/** `data` looks like a Commodore 128 `.crt` file. */
export function isC128Crt(data: Uint8Array): boolean {
  if (data.length < 0x40) return false;
  for (let i = 0; i < SIGNATURE.length; i++) if (data[i] !== SIGNATURE.charCodeAt(i)) return false;
  return true;
}

export class C128FunctionRom {
  /** The 16K images for $8000-$BFFF by bank number; one bank unless the board switches them. */
  readonly lowBanks: (Uint8Array | undefined)[] = [];
  /** $C000-$FFFF by bank number: one bank, but for Comal 80's six. $FF where the image has nothing. */
  readonly highBanks: (Uint8Array | undefined)[] = [];
  /** Partner 128's 8K of RAM, as 64 blocks of 128 bytes. */
  readonly ram = new Uint8Array(0x2000).fill(0xFF);
  /** The bank at $8000, the bank at $C000 (Comal), Partner's block in the $DE00 window and
   *  Comal's register as it was written. */
  bank = 0;
  highBank = 0;
  ramBlock = 0;
  comalReg = 0;
  /** Which 8K quarters a bank has had chips loaded into (bit 0 the lower), for the mirror. */
  private readonly loaded = new WeakMap<Uint8Array, number>();

  constructor(readonly name: string, readonly type: C128CartType = 'generic') {
    this.bankAt(0);
    this.highBankAt(0);
  }

  /** The 16K bank `n` for filling, made (all $FF) if it is not there. */
  bankAt(n: number): Uint8Array {
    return this.lowBanks[n] ?? (this.lowBanks[n] = new Uint8Array(HALF).fill(0xFF));
  }

  highBankAt(n: number): Uint8Array {
    return this.highBanks[n] ?? (this.highBanks[n] = new Uint8Array(HALF).fill(0xFF));
  }

  /** $8000-$BFFF of bank 0. */
  get low(): Uint8Array { return this.bankAt(0); }
  /** $C000-$FFFF of bank 0. */
  get high(): Uint8Array { return this.highBankAt(0); }

  /** Put a chip's bytes in a half at `offset` (0 or $2000 for an 8K one), noting what was filled. */
  fill(half: Uint8Array, offset: number, data: Uint8Array): void {
    half.set(data.subarray(0, HALF - offset), offset);
    let mask = this.loaded.get(half) ?? 0;
    if (offset === 0) mask |= 1;
    if (offset + data.length > QUARTER) mask |= 2;
    if (offset >= QUARTER) mask |= 2;
    this.loaded.set(half, mask);
  }

  /** A chip of 8K in the lower quarter is mirrored into the upper one, as the
   *  half's decoding shows it twice. Called when every chip is in. */
  mirrorShort(): void {
    for (const half of [...this.lowBanks, ...this.highBanks]) {
      if (half && this.loaded.get(half) === 1) half.copyWithin(QUARTER, 0, QUARTER);
    }
  }

  /** Power-up: bank 0 and the first RAM block (the RAM itself keeps what it held). */
  reset(): void {
    this.bank = 0;
    this.highBank = 0;
    this.ramBlock = 0;
    this.comalReg = 0;
  }

  /** The byte at a CPU address in $8000-$FFFF. */
  byte(addr: number): number {
    if (addr < 0xC000) return this.lowBanks[this.bank]?.[addr - 0x8000] ?? 0xFF;
    return this.highBanks[this.highBank]?.[addr - 0xC000] ?? 0xFF;
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
    if (this.type === 'comal' && addr >= 0xDE00 && addr <= 0xDEFF) return this.comalReg;
    return 0xFF;
  }

  /** The bank mask of a Magic Desk: the next power of two of the banks loaded. */
  private get deskMask(): number {
    const n = this.lowBanks.reduce((count, b, i) => (b ? i + 1 : count), 0);
    return Math.min(BANKS, roundUpPow2(Math.max(1, n))) - 1;
  }

  ioWrite(addr: number, value: number): void {
    const v = value & 0xFF;
    if (this.type === 'magicdesk' && addr >= 0xDE00 && addr <= 0xDEFF) this.bank = v & this.deskMask;
    else if (this.type === 'comal' && addr >= 0xDE00 && addr <= 0xDEFF) {
      this.comalReg = v & 0xF0;
      this.highBank = [0, 0, 2, 4][(v >> 5) & 3] | ((v >> 4) & 1);
    } else if (this.type === 'partner') {
      if (addr >= 0xDE00 && addr <= 0xDE7F) this.ram[(this.ramBlock << 7) | (addr & 0x7F)] = v;
      else if (addr >= 0xDE80 && addr <= 0xDEFF) this.ramBlock = v & 0x3F;
    }
  }

  /** What the debugger shows about it. */
  describe(): string[] {
    const used = (a: Uint8Array | undefined): string => (a && a.some(b => b !== 0xFF) ? '16K' : 'empty');
    const out = [`${C128_CART_TYPE_NAMES[this.type]}: $8000-$BFFF ${used(this.lowBanks[this.bank])}   $C000-$FFFF ${used(this.highBanks[this.highBank])}`];
    if (this.type === 'magicdesk') out.push(`bank ${this.bank} (of ${this.lowBanks.reduce((n, b, i) => (b ? i + 1 : n), 0)})`);
    if (this.type === 'comal') out.push(`bank ${this.highBank} of ${COMAL_BANKS} at $C000, register $${this.comalReg.toString(16).toUpperCase().padStart(2, '0')}`);
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
    // Comal 80's other banks and registers.
    w.u8(this.highBank); w.u8(this.comalReg);
    const upper = this.highBanks.flatMap((b, i) => (b && i > 0 ? [i] : []));
    w.u8(upper.length);
    for (const i of upper) { w.u8(i); w.raw(this.highBanks[i]!); }
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
    rom.highBank = r.u8(); rom.comalReg = r.u8();
    for (let n = r.u8(); n > 0; n--) { const i = r.u8(); r.rawInto(rom.highBankAt(i)); }
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
    return { error: HW_REFUSED[hw] ? `The ${HW_REFUSED[hw]} cartridge is not supported` : `C128 cartridge hardware type ${hw} is not supported` };
  }
  let name = '';
  for (let i = 0x20; i < 0x40 && data[i] !== 0; i++) name += String.fromCharCode(data[i]);
  const rom = new C128FunctionRom(name, type);
  // A Magic Desk's chips are its banks and a Comal 80's too, taken in the file's order
  // (the bank field is not trusted: boards' files give the same one for all).
  const banked = type === 'magicdesk' || type === 'comal';
  const limit = type === 'magicdesk' ? BANKS : type === 'comal' ? COMAL_BANKS : 1;
  let at = Math.max(headerLen, 0x40);
  let chips = 0;
  let order = 0;
  while (at + 0x10 <= data.length) {
    if (String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]) !== 'CHIP') {
      return { error: `Cartridge file is damaged (no CHIP packet at ${at})` };
    }
    const total = be32(data, at + 4);
    const load = be16(data, at + 12);
    const size = be16(data, at + 14);
    if (total < 0x10 || at + 0x10 + size > data.length) return { error: 'Cartridge file is truncated' };
    if (load < 0x8000 || load + size > 0x10000 || (load < 0xC000 && load + size > 0xC000)) {
      return { error: `Cartridge chip loads at $${load.toString(16).toUpperCase()}, which is not a function ROM address` };
    }
    if (be16(data, at + 8) !== 1) {                         // 1 is RAM: nothing to load
      if (type === 'comal' ? load < 0xC000 : load >= 0xC000 && type !== 'generic') {
        return { error: `A ${C128_CART_TYPE_NAMES[type]} cartridge has nothing at $${type === 'comal' ? '8000' : 'C000'}` };
      }
      const bank = banked ? order++ : 0;
      if (bank >= limit) {
        return { error: banked ? `A ${C128_CART_TYPE_NAMES[type]} cartridge has at most ${limit} banks` : `A ${C128_CART_TYPE_NAMES[type]} cartridge has no banks` };
      }
      const half = load < 0xC000 ? rom.bankAt(bank) : rom.highBankAt(bank);
      rom.fill(half, load & (HALF - 1), data.subarray(at + 0x10, at + 0x10 + size));
      chips++;
    }
    at += Math.max(total, 0x10);
  }
  if (chips === 0) return { error: 'Cartridge file holds no ROM' };
  rom.mirrorShort();
  // These two boards decode only the $8000 half and show it at $C000 too.
  if (type === 'warpspeed' || type === 'partner') rom.high.set(rom.low);
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

/** A bare function ROM image: 8K (mirrored to 16K) or 16K for $8000 and $C000
 *  both, or 32K for the two halves. */
export function parseFunctionRomImage(data: Uint8Array, name: string): C128FunctionRomParse {
  if (data.length !== QUARTER && data.length !== HALF && data.length !== 0x8000) {
    return { error: 'A bare function ROM is 8K, 16K or 32K' };
  }
  const rom = new C128FunctionRom(name);
  rom.fill(rom.low, 0, data.subarray(0, HALF));
  if (data.length > HALF) rom.fill(rom.high, 0, data.subarray(HALF));
  rom.mirrorShort();
  if (data.length <= HALF) rom.high.set(rom.low);
  return { rom };
}
