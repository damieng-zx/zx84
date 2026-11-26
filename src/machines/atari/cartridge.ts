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
 * A headerless 64K dump may instead be a Williams board (eight 8K banks all at
 * $A000, selected by the low three bits of the $D5xx address, $D508-$D50F
 * uncovers RAM); its boot vectors sit in bank 0 and tell it apart.
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
  | 'will64'
  | 'bb40';

/** `.car` header type numbers for the boards supported here. */
const CAR_TYPES: Readonly<Record<number, AtariCartType>> = {
  1: 'std8', 2: 'std16', 3: 'oss-034m', 8: 'will64', 12: 'xegs32', 13: 'xegs64',
  14: 'xegs128', 15: 'oss-m091', 18: 'bb40', 44: 'oss8', 45: 'oss-043m',
};

/** How much ROM each board carries. */
const CART_SIZE: Readonly<Record<AtariCartType, number>> = {
  std8: 0x2000, std16: 0x4000,
  'oss-m091': 0x4000, 'oss-034m': 0x4000, 'oss-043m': 0x4000, oss8: 0x2000,
  xegs32: 0x8000, xegs64: 0x10000, xegs128: 0x20000,
  will64: 0x10000,
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

export type CartParse = { type: AtariCartType; image: Uint8Array } | { error: string };

/** The cartridge-present byte and two vectors at `end - 6` look like a
 *  cartridge's: flag 0, init and run inside the cartridge window. */
function vectorsAt(d: Uint8Array, end: number, low: number): boolean {
  const run = d[end - 6] | (d[end - 5] << 8);
  const init = d[end - 2] | (d[end - 1] << 8);
  return d[end - 4] === 0 && init >= low && init < 0xC000 && (run === 0 || (run >= low && run < 0xC000));
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
    // A headerless dump larger than 16K is the matching XEGS board: the
    // 1987 Atari carts (Archon, Blue Max, Ballblazer, ...) are 8K XEGS banks,
    // with the last bank fixed at $A000-$BFFF.
    else if (image.length === 0x8000) type = 'xegs32';
    else if (image.length === 0x10000) {
      // A 64K XEGS cart boots from vectors in its fixed last bank; a Williams
      // one maps all eight banks at $A000, so its vectors are at the end of
      // bank 0.
      type = vectorsAt(image, 0x10000, 0x8000) ? 'xegs64'
        : vectorsAt(image, 0x2000, 0xA000) ? 'will64' : 'xegs64';
    }
    else if (image.length === 0x20000) type = 'xegs128';
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
  private readonly table: readonly number[] | null;
  private readonly fixed: number;
  /** Image offset at $A000-$AFFF, or OFF / FF / one of the wired-AND banks. */
  private aBank = 0;
  /** XEGS: 8K banks in the image (the last one fixed at $A000). */
  private readonly xegsBanks: number;
  /** Williams 64K: eight 8K banks, all at $A000. */
  private readonly willBanks: boolean;
  /** Bounty Bob 40K: the 4K bank at $8000 and the one at $9000. */
  private bbLo = 0;
  private bbHi = 4;
  /** The two wired-AND banks of the 034M and 043M, 4K each, built from the
   *  chips of `image`. */
  private readonly synth: Uint8Array | null;

  constructor(readonly type: AtariCartType, readonly image: Uint8Array) {
    this.base = type === 'std8' || type.startsWith('oss') || type === 'will64' ? 0xA000 : 0x8000;
    this.table = BANK_TABLES[type] ?? null;
    this.fixed = FIXED_BANK[type] ?? 0;
    this.xegsBanks = type === 'xegs32' ? 4 : type === 'xegs64' ? 8 : type === 'xegs128' ? 16 : 0;
    this.willBanks = type === 'will64';
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

  get bankSwitched(): boolean {
    return this.table !== null || this.xegsBanks > 0 || this.willBanks || this.type === 'bb40';
  }

  /** Which banks are mapped, for snapshots: an image offset, the markers for
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

  /** True while the cartridge is answering at all (OSS "off" uncovers RAM). */
  get enabled(): boolean { return this.aBank !== OFF; }

  reset(): void {
    this.aBank = this.table ? this.table[0] : 0;
    this.bbLo = 0;
    this.bbHi = 4;
  }

  /**
   * A read or write of the cartridge control area $D500-$D5FF. OSS boards
   * react to the access address, XEGS boards to the byte written (reads do
   * not switch them), and Bounty Bob switches on accesses inside its own
   * window instead (see `read`).
   */
  control(addr: number, write: boolean, value: number): void {
    if (this.table) {
      this.aBank = this.table[addr & 0x0F];
    } else if (this.xegsBanks > 0 && write) {
      this.aBank = value & (this.xegsBanks - 1);
    } else if (this.willBanks) {
      this.aBank = (addr & 0x08) !== 0 ? OFF : addr & 0x07;
    }
  }

  /** The byte at `addr`, or -1 if the cartridge does not cover it now. */
  read(addr: number, sideEffects = true): number {
    if (addr < this.base || addr >= 0xC000) return -1;
    if (this.willBanks) {
      return this.aBank === OFF ? -1 : this.image[this.aBank * 0x2000 + (addr - 0xA000)];
    }
    if (this.xegsBanks > 0) {
      const bank = addr >= 0xA000 ? this.xegsBanks - 1 : this.aBank;
      return this.image[bank * 0x2000 + (addr & 0x1FFF)];
    }
    if (this.type === 'bb40') {
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
    if (!this.table) return this.image[addr - this.base];
    if (this.aBank === OFF) return -1;
    if (addr >= 0xB000) return this.image[this.fixed + (addr - 0xB000)];
    if (this.aBank === FF) return 0xFF;
    if (this.aBank >= AND_X1) return this.synth![this.aBank - AND_X1 + (addr - 0xA000)];
    return this.image[this.aBank + (addr - 0xA000)];
  }
}
