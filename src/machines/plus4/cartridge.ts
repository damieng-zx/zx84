/**
 * Plus/4 cartridges: ROM on the expansion port, in the two 16K banks the TED
 * selects (`$8000-$BFFF` low and `$C000-$FFFF` high, chosen at `$FDD0-$FDDF`).
 *
 * The files come two ways:
 *
 *  - VICE's `.crt`: a "C64 CARTRIDGE " header then CHIP packets. A chip's
 *    `bank` says which ROM of the cartridge it belongs to (0 = the first, 1 =
 *    the second) and its load address says which half (`$8000` low, `$C000`
 *    high). Only plain ROM cartridges are taken (hardware types that carry
 *    their own banking logic are refused with their number).
 *  - A raw image: 16K, 32K or 64K of ROM, placed from `$8000` upward, which is
 *    how the Plus/4 cartridge files in the wild are usually shipped (`.bin`).
 *
 * The ROMs are 16K banks; a smaller image is padded with `$FF`, which is what
 * an empty bank reads as.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

export interface Plus4Cartridge {
  readonly name: string;
  /** The ROM that answers at `$8000-$BFFF`, or null for an empty bank. */
  readonly low: Uint8Array | null;
  /** The ROM that answers at `$C000-$FFFF`, or null for an empty bank. */
  readonly high: Uint8Array | null;
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

function parseCrt(data: Uint8Array, name: string): Plus4Cartridge | { error: string } {
  const be32 = (at: number) => ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
  const be16 = (at: number) => (data[at] << 8) | data[at + 1];
  if (data.length < 0x40) return { error: 'the .crt file is cut short' };
  if (String.fromCharCode(...data.subarray(0, 13)) !== 'C64 CARTRIDGE') return { error: 'not a .crt (no "C64 CARTRIDGE" header)' };
  const headerLen = be32(0x10);
  const type = be16(0x16);
  if (type !== 0) return { error: `.crt hardware type ${type} is not supported (only plain ROM cartridges, type 0)` };
  let at = Math.max(0x40, headerLen);
  let low: Uint8Array | null = null;
  let high: Uint8Array | null = null;
  let chips = 0;
  while (at + 0x10 <= data.length) {
    if (String.fromCharCode(...data.subarray(at, at + 4)) !== 'CHIP') return { error: 'a CHIP packet of the .crt is damaged' };
    const len = be32(at + 4);
    const bank = be16(at + 8);
    const addr = be16(at + 0x0C);
    const size = be16(at + 0x0E);
    if (len < 0x10 || at + 0x10 + size > data.length) return { error: 'a CHIP packet of the .crt is cut short' };
    // The Plus/4's cartridges are two plain ROMs: a chip's bank names which,
    // and its load address says which half — the two must agree.
    const target = bank === 0 ? 0x8000 : 0xC000;
    if (addr !== target) return { error: `a CHIP of the .crt loads at $${addr.toString(16).toUpperCase()} in bank ${bank}` };
    const placed = place(low, high, target, data.subarray(at + 0x10, at + 0x10 + size));
    if (typeof placed === 'string') return { error: placed };
    low = placed.low; high = placed.high;
    chips++;
    at += len;
  }
  if (chips === 0) return { error: 'the .crt has no ROM in it' };
  return { name: name.replace(/\.[^.]+$/, ''), low, high };
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
  return { cart: { name: base.replace(/\.[^.]+$/, ''), low, high } };
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
  w.bool(cart.low !== null);
  if (cart.low) w.raw(cart.low);
  w.bool(cart.high !== null);
  if (cart.high) w.raw(cart.high);
}

export function loadCartridge(r: StateReader): Plus4Cartridge | null {
  if (!r.bool()) return null;
  const name = r.str();
  let low: Uint8Array | null = null;
  let high: Uint8Array | null = null;
  if (r.bool()) { low = new Uint8Array(0x4000); r.rawInto(low); }
  if (r.bool()) { high = new Uint8Array(0x4000); r.rawInto(high); }
  return { name, low, high };
}
