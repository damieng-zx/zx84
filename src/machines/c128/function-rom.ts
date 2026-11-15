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
 * Files: a `.crt` with the signature `C128 CARTRIDGE` (VICE's format, chips
 * loading at $8000-$BFFF or $C000-$FFFF), or a bare image of 8K, 16K or 32K
 * (the low half first). A cartridge leaves /GAME and /EXROM high, so the BIOS
 * does not take it for a 64 cartridge.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { isCrt, parseCrt, type C64Cartridge } from '@/machines/shared/cbm/cartridge.ts';

const SIGNATURE = 'C128 CARTRIDGE';
const HALF = 0x4000;

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
  /** $8000-$BFFF and $C000-$FFFF; $FF where the image has nothing. */
  readonly low = new Uint8Array(HALF).fill(0xFF);
  readonly high = new Uint8Array(HALF).fill(0xFF);

  constructor(readonly name: string) {}

  /** The byte at a CPU address in $8000-$FFFF. */
  byte(addr: number): number {
    return addr < 0xC000 ? this.low[addr - 0x8000] : this.high[addr - 0xC000];
  }

  /** What the debugger shows about it. */
  describe(): string[] {
    const used = (a: Uint8Array): string => (a.some(b => b !== 0xFF) ? '16K' : 'empty');
    return [`$8000-$BFFF ${used(this.low)}   $C000-$FFFF ${used(this.high)}`];
  }

  saveState(w: StateWriter): void {
    w.str(this.name);
    w.raw(this.low);
    w.raw(this.high);
  }

  static loadState(r: StateReader): C128FunctionRom {
    const rom = new C128FunctionRom(r.str());
    r.rawInto(rom.low);
    r.rawInto(rom.high);
    return rom;
  }
}

/** Read a Commodore 128 `.crt` file. */
export function parseC128Crt(data: Uint8Array): C128FunctionRomParse {
  if (!isC128Crt(data)) return { error: 'Not a C128 cartridge file (.crt)' };
  const headerLen = be32(data, 0x10);
  let name = '';
  for (let i = 0x20; i < 0x40 && data[i] !== 0; i++) name += String.fromCharCode(data[i]);
  const rom = new C128FunctionRom(name);
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
    if (bank !== 0) return { error: 'Banked C128 cartridges are not supported' };
    if (load < 0x8000 || load + size > 0x10000 || (load < 0xC000 && load + size > 0xC000)) {
      return { error: `Cartridge chip loads at $${load.toString(16).toUpperCase()}, which is not a function ROM address` };
    }
    if (be16(data, at + 8) !== 1) {                         // 1 is RAM: nothing to load
      const half = load < 0xC000 ? rom.low : rom.high;
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
