/**
 * VIC-20 cartridges: ROM on the expansion port, in one or more of the 8K
 * blocks the port decodes (BLK1 $2000, BLK2 $4000, BLK3 $6000, BLK5 $A000).
 * Most are 4K or 8K in BLK5; at reset the KERNAL looks for "A0CBM" at $A004
 * and, finding it, starts the cartridge through the vector at $A000 instead of
 * BASIC. Larger games add ROM in BLK1-3.
 *
 * The files come three ways:
 *
 *  - VICE's `.crt`: a "VIC20 CARTRIDGE " header (its length, version and
 *    hardware type, big-endian) then CHIP packets, each with its load
 *    address. Only the generic type (0), plain ROM, is taken.
 *  - A load-address image: the address ($2000, $4000, $6000 or $A000) in two
 *    bytes, then the ROM. Often named `.prg`; a `.prg` is taken as a
 *    cartridge only when it loads at $A000 and carries the autostart
 *    signature, else it is a program.
 *  - A raw image named for its block: `.a0` ($A000), `.20`, `.40`, `.60`
 *    (any of these may also carry the two address bytes).
 *
 * A 4K image at the start of a block appears twice in it, as the cartridge
 * decodes only twelve address lines.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

/** The blocks a cartridge can fill. */
export const CART_BLOCKS = [1, 2, 3, 5] as const;
export type CartBlock = typeof CART_BLOCKS[number];

export interface Vic20Cartridge {
  readonly name: string;
  /** 8K of ROM per block filled. */
  readonly blocks: ReadonlyMap<CartBlock, Uint8Array>;
}

/** "A0CBM" as it sits at $A004: CBM in shifted PETSCII. */
const AUTOSTART = [0x41, 0x30, 0xC3, 0xC2, 0xCD];

/** Whether ROM at $A000 carries the autostart signature at offset 4. */
export function hasAutostart(rom: ArrayLike<number>): boolean {
  return AUTOSTART.every((b, i) => rom[4 + i] === b);
}

/** The file extensions a cartridge comes in (raw images name their block). */
export const VIC20_CART_PATTERN = /\.(crt|a0|20|40|60)$/i;

const BLOCK_BY_EXT: Readonly<Record<string, number>> = { a0: 0xA000, '20': 0x2000, '40': 0x4000, '60': 0x6000 };

class Builder {
  readonly blocks = new Map<CartBlock, Uint8Array>();

  /** Put `bytes` at `addr`, each byte in its block; a 4K piece at a block's
   *  start is repeated in the block's top half. */
  place(addr: number, bytes: Uint8Array): string | null {
    if (bytes.length === 0) return 'the cartridge is empty';
    const end = addr + bytes.length;
    for (let a = addr; a < end; a++) {
      const block = (a >> 13) as CartBlock;
      if (!(CART_BLOCKS as readonly number[]).includes(block)) {
        return `ROM at $${a.toString(16).toUpperCase()} is outside the cartridge blocks`;
      }
    }
    for (let a = addr; a < end; a++) {
      const block = (a >> 13) as CartBlock;
      let rom = this.blocks.get(block);
      if (!rom) { rom = new Uint8Array(0x2000).fill(0xFF); this.blocks.set(block, rom); }
      rom[a & 0x1FFF] = bytes[a - addr];
    }
    if (bytes.length === 0x1000 && (addr & 0x1FFF) === 0) {
      const rom = this.blocks.get((addr >> 13) as CartBlock)!;
      rom.copyWithin(0x1000, 0, 0x1000);
    }
    return null;
  }
}

/** The two address bytes a load-address image starts with, if they name a
 *  block and what follows is whole kilobytes. */
function loadAddress(data: Uint8Array): number | null {
  if (data.length < 2 + 0x400 || (data.length - 2) % 0x400 !== 0) return null;
  const addr = data[0] | (data[1] << 8);
  return addr === 0x2000 || addr === 0x4000 || addr === 0x6000 || addr === 0xA000 ? addr : null;
}

function parseCrt(data: Uint8Array, b: Builder): string | null {
  const be32 = (at: number) => ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
  const be16 = (at: number) => (data[at] << 8) | data[at + 1];
  if (data.length < 0x40) return 'the .crt file is cut short';
  const headerLen = be32(0x10);
  const type = be16(0x16);
  if (type !== 0) return `.crt hardware type ${type} is not supported (only plain ROM cartridges, type 0)`;
  let at = Math.max(0x40, headerLen);
  let chips = 0;
  while (at + 0x10 <= data.length) {
    if (String.fromCharCode(...data.subarray(at, at + 4)) !== 'CHIP') return 'a CHIP packet of the .crt is damaged';
    const len = be32(at + 4);
    const addr = be16(at + 0x0C);
    const size = be16(at + 0x0E);
    if (len < 0x10 || at + 0x10 + size > data.length) return 'a CHIP packet of the .crt is cut short';
    const err = b.place(addr, data.subarray(at + 0x10, at + 0x10 + size));
    if (err) return err;
    chips++;
    at += len;
  }
  return chips > 0 ? null : 'the .crt has no ROM in it';
}

/**
 * Read a cartridge file. `name` decides how a raw image is placed. Returns
 * the cartridge, or why the file is not one.
 */
export function parseVic20Cartridge(data: Uint8Array, name: string): { cart: Vic20Cartridge } | { error: string } {
  const b = new Builder();
  const base = name.replace(/^.*[\\/]/, '');
  const ext = /\.([^.]+)$/.exec(base)?.[1]?.toLowerCase() ?? '';
  let err: string | null;
  if (String.fromCharCode(...data.subarray(0, 16)) === 'VIC20 CARTRIDGE ') {
    err = parseCrt(data, b);
  } else if (ext === 'crt') {
    err = 'not a VIC-20 .crt (no "VIC20 CARTRIDGE" header)';
  } else if (loadAddress(data) !== null && (BLOCK_BY_EXT[ext] === undefined || loadAddress(data) === BLOCK_BY_EXT[ext])) {
    err = b.place(loadAddress(data)!, data.subarray(2));
  } else if (BLOCK_BY_EXT[ext] !== undefined) {
    err = data.length > 0x2000 && BLOCK_BY_EXT[ext] === 0xA000
      ? 'a raw $A000 image holds at most 8K'
      : b.place(BLOCK_BY_EXT[ext], data);
  } else {
    err = 'not a cartridge image: name it .a0, .20, .40 or .60 for the block it goes in, or give it its load address';
  }
  if (err) return { error: err };
  return { cart: { name: base.replace(/\.[^.]+$/, ''), blocks: b.blocks } };
}

/** Whether a `.prg` is a cartridge rather than a program: it loads at $A000
 *  and starts with the autostart signature. */
export function isCartridgePrg(data: Uint8Array): boolean {
  return data.length >= 2 + 9 && data[0] === 0x00 && data[1] === 0xA0 && hasAutostart(data.subarray(2));
}

export function saveCartridge(w: StateWriter, cart: Vic20Cartridge | null): void {
  w.bool(cart !== null);
  if (!cart) return;
  w.str(cart.name);
  for (const block of CART_BLOCKS) {
    const rom = cart.blocks.get(block);
    w.bool(rom !== undefined);
    if (rom) w.raw(rom);
  }
}

export function loadCartridge(r: StateReader): Vic20Cartridge | null {
  if (!r.bool()) return null;
  const name = r.str();
  const blocks = new Map<CartBlock, Uint8Array>();
  for (const block of CART_BLOCKS) {
    if (!r.bool()) continue;
    const rom = new Uint8Array(0x2000);
    r.rawInto(rom);
    blocks.set(block, rom);
  }
  return { name, blocks };
}
