/**
 * Atari 400/800/XL cartridges: the standard boards and OSS super-cartridges.
 *
 * Standard carts are plain ROM: 8K at $A000-$BFFF, or 16K at $8000-$BFFF.
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

export type AtariCartType = 'std8' | 'std16' | 'oss-m091' | 'oss-034m' | 'oss-043m' | 'oss8';

/** `.car` header type numbers for the boards supported here. */
const CAR_TYPES: Readonly<Record<number, AtariCartType>> = {
  1: 'std8', 2: 'std16', 3: 'oss-034m', 15: 'oss-m091', 44: 'oss8', 45: 'oss-043m',
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
    else return { error: `Cartridge must be 4K, 8K or 16K (got ${image.length} bytes)` };
  }
  const want = type === 'std8' || type === 'oss8' ? 0x2000 : 0x4000;
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
  /** The two wired-AND banks of the 034M and 043M, 4K each, built from the
   *  chips of `image`. */
  private readonly synth: Uint8Array | null;

  constructor(readonly type: AtariCartType, readonly image: Uint8Array) {
    this.base = type === 'std16' ? 0x8000 : 0xA000;
    this.table = BANK_TABLES[type] ?? null;
    this.fixed = FIXED_BANK[type] ?? 0;
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

  get bankSwitched(): boolean { return this.table !== null; }

  /** Which bank is at $A000, for snapshots: an image offset, or the markers
   *  for "off" and "reads $FF". */
  get bankState(): number { return this.aBank; }
  set bankState(bank: number) { this.aBank = bank; }

  /** True while the cartridge is answering at all (OSS "off" uncovers RAM). */
  get enabled(): boolean { return this.aBank !== OFF; }

  reset(): void {
    this.aBank = this.table ? this.table[0] : 0;
  }

  /** A read or write of $D5xx: bank-switching carts change bank. */
  control(nibble: number): void {
    if (this.table) this.aBank = this.table[nibble & 0x0F];
  }

  /** The byte at `addr`, or -1 if the cartridge does not cover it now. */
  read(addr: number): number {
    if (addr < this.base || addr >= 0xC000) return -1;
    if (!this.table) return this.image[addr - this.base];
    if (this.aBank === OFF) return -1;
    if (addr >= 0xB000) return this.image[this.fixed + (addr - 0xB000)];
    if (this.aBank === FF) return 0xFF;
    if (this.aBank >= AND_X1) return this.synth![this.aBank - AND_X1 + (addr - 0xA000)];
    return this.image[this.aBank + (addr - 0xA000)];
  }
}
