/**
 * Atari 400/800/XL cartridges: the standard boards, OSS super-cartridges and
 * the later bank-switched boards.
 *
 * Standard carts are plain ROM: 8K at $A000-$BFFF, or 16K at $8000-$BFFF.
 *
 * XEGS boards (the 1987 Atari releases and the XEGS line) hold 8K banks: the
 * last is fixed at $A000-$BFFF and the low two, three or four bits of the byte
 * written to $D500-$D5FF pick the bank at $8000-$9FFF, for a 32K, 64K or 128K
 * image. The same image shapes arrive headerless or in a `.car` (types 12-14).
 *
 * The other 8K-bank boards all map their banks at $A000-$BFFF and differ in
 * where the bank number is written:
 *
 *   Williams 32K/64K  $D500-$D507 select banks 0-3 / 0-7, $D508-$D50F off
 *   DB 32K            low two address bits select the $8000 bank, bank 3
 *                     stays at $A000
 *   Express 64K       $D577 = bank 0 down to $D570 = bank 7, $D578-$D57F off
 *   Diamond 64K       $D5D7 = bank 0 down to $D5D0 = bank 7, $D5D8-$D5DF off
 *   SpartaDOS X 64K   $D5E7 = bank 0 down to $D5E0 = bank 7, $D5E8-$D5EF off
 *   SpartaDOS X 128K  $D5F7-$D5F0 = banks 0-7, $D5E7-$D5E0 = banks 8-15
 *   Atarimax 128K     $D500-$D50F = banks 0-15, $D510-$D51F off
 *
 * A headerless 64K dump is told apart by the control page its code writes
 * (SDX/Express/Diamond) and then by where its boot vectors sit (XEGS has them
 * in the fixed last bank, the $A000 boards in bank 0). 128K is SDX when it
 * writes the SDX pages, XEGS when its vectors are in the fixed last bank, and
 * Atarimax otherwise.
 *
 * Bounty Bob's 40K board is stranger: four 4K banks at $8000-$8FFF, four at
 * $9000-$9FFF and its last 8K at $A000-$BFFF, with an access to $8FF6-$8FF9 or
 * $9FF6-$9FF9 selecting the 4K bank in that window.
 *
 * OSS super-cartridges (MAC/65, BASIC XL, BASIC XE, Action!, DOS XL, ...)
 * fit 16K into the 8K window by bank switching through the cartridge control
 * area: any read or write of $D500-$D5FF selects what $A000-$AFFF shows,
 * by the low four address bits, while $B000-$BFFF holds a fixed bank. Each
 * board decodes the bits differently, and dumps lay their 4K banks out in
 * board order, so a type is needed to map them:
 *
 *   M091 (one chip)  fixed $B000 = image $0000. Bits 3 and 0 decide:
 *                    %0xx0 $1000, %0xx1 $3000, %1xx1 $2000, %1xx0 off
 *   034M (two chip)  fixed $B000 = image $3000. $x0 $0000, $x3/$x7 $1000,
 *                    $x4 $2000; $x2/$x6 read $FF; $x1 and $x5 read the two
 *                    chips selected together, wired-AND (chips 0 and 1, then
 *                    2 and 1); $x8-$xF off
 *   043M (two chip)  as 034M with $x3/$x7 and $x4 swapped, and $x1 selecting
 *                    chips 0 and 2 together
 *   OSS 8K           fixed $B000 = image $0000; $x0-$x7 $1000, odd $x9-$xF
 *                    $0000, even $x8-$xE off
 *
 * "Off" removes the cartridge from $A000-$BFFF altogether, uncovering the RAM
 * (or XL BASIC) beneath. OSS ROMs keep their own bank number in the last byte
 * of each switchable bank, which is what lets a headerless dump's board be
 * recognised. `.car` files say their type in a 16-byte header.
 */

export type AtariCartType =
  | 'std8' | 'std16'
  | 'oss-m091' | 'oss-034m' | 'oss-043m' | 'oss8'
  | 'xegs32' | 'xegs64' | 'xegs128'
  | 'will32' | 'will64'
  | 'express64' | 'diamond64'
  | 'sdx64' | 'sdx128'
  | 'atarimax128'
  | 'db32'
  | 'mega16' | 'mega32' | 'mega64' | 'mega128' | 'mega256' | 'mega512' | 'mega1024'
  | 'bb40';

/** `.car` header type numbers for the boards supported here. */
const CAR_TYPES: Readonly<Record<number, AtariCartType>> = {
  1: 'std8', 2: 'std16', 3: 'oss-034m', 5: 'db32', 8: 'will64', 9: 'express64',
  10: 'diamond64', 11: 'sdx64', 12: 'xegs32', 13: 'xegs64', 14: 'xegs128',
  15: 'oss-m091', 18: 'bb40', 22: 'will32', 26: 'mega16', 27: 'mega32',
  28: 'mega64', 29: 'mega128', 30: 'mega256', 31: 'mega512', 32: 'mega1024',
  41: 'atarimax128', 43: 'sdx128', 44: 'oss8', 45: 'oss-043m',
};

/** How much ROM each board carries. */
const CART_SIZE: Readonly<Record<AtariCartType, number>> = {
  std8: 0x2000, std16: 0x4000,
  'oss-m091': 0x4000, 'oss-034m': 0x4000, 'oss-043m': 0x4000, oss8: 0x2000,
  xegs32: 0x8000, xegs64: 0x10000, xegs128: 0x20000,
  will32: 0x8000, will64: 0x10000,
  express64: 0x10000, diamond64: 0x10000,
  sdx64: 0x10000, sdx128: 0x20000,
  atarimax128: 0x20000,
  db32: 0x8000,
  mega16: 0x4000, mega32: 0x8000, mega64: 0x10000, mega128: 0x20000,
  mega256: 0x40000, mega512: 0x80000, mega1024: 0x100000,
  bb40: 0xa000,
};

const OFF = -1;
const FF = -2;
/** Banks that are two chips driving the bus at once, read as their wired-AND.
 *  They sit in a table above any image offset, in `AtariCartridge.synth`. */
const AND_X1 = 0x10000;
const AND_X5 = 0x11000;

/** $A000-$AFFF source per $D5xx low nibble: an image offset, OFF or FF. */
const BANK_TABLES: Readonly<Partial<Record<AtariCartType, readonly number[]>>> = {
  'oss-m091': [
    0x1000, 0x3000, 0x1000, 0x3000, 0x1000, 0x3000, 0x1000, 0x3000,
    OFF, 0x2000, OFF, 0x2000, OFF, 0x2000, OFF, 0x2000,
  ],
  'oss-034m': [0x0000, AND_X1, FF, 0x1000, 0x2000, AND_X5, FF, 0x1000, OFF, OFF, OFF, OFF, OFF, OFF, OFF, OFF],
  'oss-043m': [0x0000, AND_X1, FF, 0x2000, 0x1000, AND_X5, FF, 0x2000, OFF, OFF, OFF, OFF, OFF, OFF, OFF, OFF],
  oss8: [
    0x1000, 0x1000, 0x1000, 0x1000, 0x1000, 0x1000, 0x1000, 0x1000,
    OFF, 0x0000, OFF, 0x0000, OFF, 0x0000, OFF, 0x0000,
  ],
};
/** Image offset of the fixed $B000-$BFFF bank. */
const FIXED_BANK: Readonly<Partial<Record<AtariCartType, number>>> = {
  'oss-m091': 0x0000, 'oss-034m': 0x3000, 'oss-043m': 0x3000, oss8: 0x0000,
};

/** How a board maps its ROM into the address space and banks it. */
type CartKind =
  | 'plain'      // one ROM window (std8/std16)
  | 'oss'        // 4K banks through the $D5xx nibble table
  | 'xegs'       // 8K banks at $8000, last fixed, value written
  | 'db32'       // 8K banks at $8000, bank 3 fixed, address bits
  | 'a000'       // 8K banks at $A000 through a control page
  | 'sdx128'     // SDX's two control pages, 8K banks at $A000
  | 'atarimax'   // $D500-$D50F banks, $D510-$D51F off, 8K at $A000
  | 'mega'       // 16K banks at $8000, value's low bits, bit 7 off
  | 'bb40';      // Bounty Bob's 4K windows

function kindOf(type: AtariCartType): CartKind {
  if (type.startsWith('oss')) return 'oss';
  if (type.startsWith('xegs')) return 'xegs';
  if (type === 'db32') return 'db32';
  if (type === 'will32' || type === 'will64' || type === 'express64' || type === 'diamond64' || type === 'sdx64') return 'a000';
  if (type === 'sdx128') return 'sdx128';
  if (type === 'atarimax128') return 'atarimax';
  if (type.startsWith('mega')) return 'mega';
  if (type === 'bb40') return 'bb40';
  return 'plain';
}

/** The control page of the address-decoded $A000 boards. */
const CONTROL_PAGE: Readonly<Partial<Record<AtariCartType, number>>> = {
  will32: 0x00, will64: 0x00, express64: 0x70, diamond64: 0xd0, sdx64: 0xe0,
};

export type CartParse = { type: AtariCartType; image: Uint8Array } | { error: string };

/** The cartridge-present byte and two vectors at `end - 6` look like a
 *  cartridge's: flag 0, init and run inside the cartridge window. */
function vectorsAt(d: Uint8Array, end: number, low: number): boolean {
  const run = d[end - 6] | (d[end - 5] << 8);
  const init = d[end - 2] | (d[end - 1] << 8);
  return d[end - 4] === 0 && init >= low && init < 0xC000 && (run === 0 || (run >= low && run < 0xC000));
}

/** Opcodes that write an absolute address, for spotting a board's control
 *  register in a headerless dump. */
const WRITE_OPS = new Set([0x8c, 0x8d, 0x8e, 0x99, 0x9d]);

/** Whether the image contains a write to some $D5xx address passing `pred`. */
function writesWhere(d: Uint8Array, pred: (lowByte: number) => boolean): boolean {
  for (let i = 0; i + 2 < d.length; i++) {
    if (WRITE_OPS.has(d[i]) && d[i + 2] === 0xd5 && pred(d[i + 1])) return true;
  }
  return false;
}

/** Whether the image writes anywhere in control page `page` ($D5x0-$D5xF). */
function writesPage(d: Uint8Array, page: number): boolean {
  return writesWhere(d, lo => (lo & 0xf0) === page);
}

/** Work out a headerless 8K dump's board: a standard cartridge has its
 *  vectors at the top, an OSS one only in the first 4K, which sits at $B000. */
function detect8k(d: Uint8Array): AtariCartType {
  if (!vectorsAt(d, 0x2000, 0xA000) && vectorsAt(d, 0x1000, 0xA000)) return 'oss8';
  return 'std8';
}

/** Work out a headerless 16K dump's board. */
function detect16k(d: Uint8Array): AtariCartType {
  const ids = (a: number, b: number, c: number) => [d[a], d[b], d[c]].join(',');
  if (ids(0x1fff, 0x2fff, 0x3fff) === '0,9,1') return 'oss-m091';
  if (ids(0x0fff, 0x1fff, 0x2fff) === '0,3,4') return 'oss-034m';
  if (ids(0x0fff, 0x1fff, 0x2fff) === '0,4,3') return 'oss-043m';
  // Vectors only in the first bank: a one-chip OSS dump without bank ids.
  if (!vectorsAt(d, 0x4000, 0x8000) && vectorsAt(d, 0x1000, 0xA000)) return 'oss-m091';
  return 'std16';
}

/** Work out a headerless 32K dump's board. */
function detect32k(d: Uint8Array): AtariCartType {
  // XEGS writes the bank number to $D500; DB/Williams boards write to
  // $D501-$D503. That address pattern is the reliable tell.
  const addressBanked = writesWhere(d, lo => lo >= 0x01 && lo <= 0x03);
  if (!addressBanked) return 'xegs32';
  // DB32K keeps bank 3 fixed at $A000, so its vectors are at the end; a
  // Williams 32K boots from bank 0 at $A000.
  return vectorsAt(d, 0x8000, 0xA000) ? 'db32' : 'will32';
}

/** Work out a headerless 64K dump's board. */
function detect64k(d: Uint8Array): AtariCartType {
  // The $A000 boards all keep their boot vectors at the end of every bank, so
  // the vector block cannot tell them apart. Their code's control page can.
  if (writesPage(d, 0xe0)) return 'sdx64';
  if (writesPage(d, 0x70)) return 'express64';
  if (writesPage(d, 0xd0)) return 'diamond64';
  // A fixed final bank is XEGS; otherwise it is a Williams board.
  if (vectorsAt(d, 0x10000, 0x8000)) return 'xegs64';
  return 'will64';
}

/** Work out a headerless 128K dump's board. */
function detect128k(d: Uint8Array): AtariCartType {
  if (writesPage(d, 0xe0) || writesPage(d, 0xf0)) return 'sdx128';
  if (vectorsAt(d, 0x20000, 0x8000)) return 'xegs128';
  if (vectorsAt(d, 0x2000, 0xA000)) return 'atarimax128';
  return 'xegs128';
}

/** Identify a cartridge image (raw or `.car`). */
export function parseCartridge(data: Uint8Array): CartParse {
  let image = data;
  let type: AtariCartType | null = null;
  if (data.length >= 16 && String.fromCharCode(data[0], data[1], data[2], data[3]) === 'CART') {
    const n = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
    type = CAR_TYPES[n] ?? null;
    if (!type) return { error: `Cartridge type ${n} is not supported` };
    image = data.subarray(16);
  }
  if (image.length === 0x1000) {
    // A 4K cart answers in the top half of the 8K window; the half below it
    // has nothing to drive the bus and reads $FF.
    const top = new Uint8Array(0x2000).fill(0xFF);
    top.set(image, 0x1000);
    return { type: 'std8', image: top };
  }
  if (!type) {
    if (image.length === 0x2000) type = detect8k(image);
    else if (image.length === 0x4000) type = detect16k(image);
    else if (image.length === 0x8000) type = detect32k(image);
    else if (image.length === 0x10000) type = detect64k(image);
    else if (image.length === 0x20000) type = detect128k(image);
    else if (image.length === 0xa000) type = 'bb40';
    else return { error: `Cartridge must be 4K, 8K, 16K, 32K, 40K, 64K or 128K (got ${image.length} bytes)` };
  }
  const want = CART_SIZE[type];
  if (image.length !== want) return { error: `A ${type} cartridge is ${want / 1024}K (got ${image.length} bytes)` };
  return { type, image: image.slice() };
}

export class AtariCartridge {
  /** Where the cartridge's window starts. */
  readonly base: number;
  private readonly kind: CartKind;
  private readonly table: readonly number[] | null;
  private readonly fixed: number;
  /** The current bank: an image bank number, or OFF / FF / a wired-AND
   *  marker for the OSS boards. */
  private aBank = 0;
  /** 8K banks for the XEGS / $A000 / SDX boards, 16K banks for MegaCart. */
  private readonly romBanks: number;
  /** The control page of the address-decoded $A000 boards. */
  private readonly controlPage: number;
  /** Those boards count banks down from the top ($D5x7 = bank 0). */
  private readonly reverse: boolean;
  /** Bounty Bob 40K: the 4K bank at $8000 and the one at $9000. */
  private bbLo = 0;
  private bbHi = 4;
  /** The two wired-AND banks of the 034M and 043M, 4K each, built from the
   *  chips of `image`. */
  private readonly synth: Uint8Array | null;

  constructor(readonly type: AtariCartType, readonly image: Uint8Array) {
    this.kind = kindOf(type);
    this.base = this.kind === 'plain' || this.kind === 'oss' || this.kind === 'a000'
      || this.kind === 'sdx128' || this.kind === 'atarimax'
      ? (type === 'std16' ? 0x8000 : 0xA000)
      : 0x8000;
    this.table = BANK_TABLES[type] ?? null;
    this.fixed = FIXED_BANK[type] ?? 0;
    this.romBanks = CART_SIZE[type] / (this.kind === 'mega' ? 0x4000 : 0x2000);
    this.controlPage = CONTROL_PAGE[type] ?? 0;
    this.reverse = type === 'express64' || type === 'diamond64' || type === 'sdx64';
    this.synth = null;
    if (type === 'oss-034m' || type === 'oss-043m') {
      // $x1 reads chips 0 and 1 (034M) or 0 and 2 (043M) together, $x5 chips
      // 2 and 1.
      const synth = new Uint8Array(0x2000);
      const second = type === 'oss-034m' ? 0x1000 : 0x2000;
      for (let i = 0; i < 0x1000; i++) {
        synth[i] = image[i] & image[second + i];
        synth[0x1000 + i] = image[0x2000 + i] & image[0x1000 + i];
      }
      this.synth = synth;
    }
    this.reset();
  }

  get bankSwitched(): boolean { return this.kind !== 'plain'; }

  /** Which banks are mapped, for snapshots: a bank number, the markers for
   *  "off" and "reads $FF", or (Bounty Bob) the two 4K bank numbers. */
  get bankState(): number {
    return this.type === 'bb40' ? this.bbLo | (this.bbHi << 8) : this.aBank;
  }
  set bankState(bank: number) {
    if (this.type === 'bb40') {
      this.bbLo = bank & 0xFF;
      this.bbHi = (bank >> 8) & 0xFF;
    } else {
      this.aBank = bank;
    }
  }

  /** True while the cartridge is answering at all (an "off" bank uncovers RAM). */
  get enabled(): boolean { return this.aBank !== OFF; }

  reset(): void {
    this.aBank = this.table ? this.table[0] : 0;
    this.bbLo = 0;
    this.bbHi = 4;
  }

  /**
   * A read or write of the cartridge control area $D500-$D5FF. The OSS and
   * address-decoded boards react to the address; XEGS, MegaCart and Atarimax
   * take the byte written (reads do not switch them). Bounty Bob switches on
   * accesses inside its own window instead (see `read`).
   */
  control(addr: number, write: boolean, value: number): void {
    switch (this.kind) {
      case 'oss':
        this.aBank = this.table![addr & 0x0F];
        return;
      case 'xegs':
        if (write) this.aBank = value & (this.romBanks - 1);
        return;
      case 'db32':
        this.aBank = addr & 0x03;
        return;
      case 'a000': {
        if ((addr & 0xF0) !== this.controlPage) return;
        if ((addr & 0x08) !== 0) { this.aBank = OFF; return; }
        const n = addr & 0x07;
        this.aBank = this.reverse ? this.romBanks - 1 - n : n & (this.romBanks - 1);
        return;
      }
      case 'sdx128': {
        const page = addr & 0xF0;
        const a = addr & 0x0F;
        if (page === 0xF0) this.aBank = a < 8 ? 7 - a : OFF;
        else if (page === 0xE0) this.aBank = a < 8 ? 15 - a : OFF;
        return;
      }
      case 'atarimax': {
        if (!write) return;
        const a = addr & 0xFF;
        if (a >= 0x20) return;
        this.aBank = a < 0x10 ? a : OFF;
        return;
      }
      case 'mega':
        if (!write) return;
        this.aBank = (value & 0x80) !== 0 ? OFF : value & (this.romBanks - 1);
        return;
      default:
        return;
    }
  }

  /** The byte at `addr`, or -1 if the cartridge does not cover it now. */
  read(addr: number, sideEffects = true): number {
    if (addr < this.base || addr >= 0xC000) return -1;
    switch (this.kind) {
      case 'xegs': {
        const bank = addr >= 0xA000 ? this.romBanks - 1 : this.aBank;
        return this.image[bank * 0x2000 + (addr & 0x1FFF)];
      }
      case 'db32': {
        const bank = addr >= 0xA000 ? 3 : this.aBank;
        return this.image[bank * 0x2000 + (addr & 0x1FFF)];
      }
      case 'a000':
      case 'sdx128':
      case 'atarimax':
        return this.aBank === OFF ? -1 : this.image[this.aBank * 0x2000 + (addr - 0xA000)];
      case 'mega':
        return this.aBank === OFF ? -1 : this.image[this.aBank * 0x4000 + (addr - 0x8000)];
      case 'bb40': {
        // A read or write at the top of a 4K bank picks the next one; the
        // same access also returns the byte it lands on.
        if (sideEffects) {
          if (addr >= 0x8FF6 && addr <= 0x8FF9) this.bbLo = addr - 0x8FF6;
          else if (addr >= 0x9FF6 && addr <= 0x9FF9) this.bbHi = 4 + addr - 0x9FF6;
        }
        if (addr >= 0xA000) return this.image[0x8000 + (addr - 0xA000)];
        if (addr >= 0x9000) return this.image[this.bbHi * 0x1000 + (addr - 0x9000)];
        return this.image[this.bbLo * 0x1000 + (addr - 0x8000)];
      }
      case 'oss': {
        if (!this.table) return this.image[addr - this.base];
        if (this.aBank === OFF) return -1;
        if (addr >= 0xB000) return this.image[this.fixed + (addr - 0xB000)];
        if (this.aBank === FF) return 0xFF;
        if (this.aBank >= AND_X1) return this.synth![this.aBank - AND_X1 + (addr - 0xA000)];
        return this.image[this.aBank + (addr - 0xA000)];
      }
      default:
        return this.image[addr - this.base];
    }
  }
}
