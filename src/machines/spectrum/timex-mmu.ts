/**
 * The Timex 2068's horizontal memory mapper.
 *
 * The 64K address space is eight 8K chunks. Port 0xF4 has a bit for each chunk
 * (bit 0 is 0x0000-0x1FFF, bit 7 is 0xE000-0xFFFF): a clear bit leaves the chunk
 * to the HOME bank (the 16K ROM below 0x4000 and 48K of RAM above it), a set bit
 * swaps in the alternate bank. Which alternate is chosen by bit 7 of port 0xFF:
 * clear selects the DOCK (a cartridge in the dock connector), set selects the
 * EXROM (the 8K ROM inside the machine, which the ROM's BASIC calls into). The two
 * alternates are exclusive, but HOME chunks mix freely with either.
 *
 * The EXROM chip is not decoded to a single chunk: it answers wherever it is
 * selected, so one 8K image shows in every chunk whose bit is set. A chunk that
 * the DOCK selects but the cartridge does not populate (or with no cartridge at
 * all) reads 0xFF and ignores writes.
 *
 * The CPU's view lives in the machine's flat 64K array (see memory.ts), so this
 * swaps a chunk's bytes in and out of it: the HOME bytes it displaces are kept in
 * `shadow`, and the alternate's RAM, if it has any, is copied back to its own
 * store when the chunk is swapped out. The hot write path asks `writable` whether a
 * chunk takes writes (HOME ROM and an alternate ROM do not).
 *
 * A dock cartridge can also stand in for the HOME bank (its bank id 255: a
 * replacement HOME ROM such as a Spectrum ROM). Only chunks 0 and 1, the ROM, are
 * replaced; the HOME RAM above is the machine's own.
 */

export const CHUNK_SIZE = 0x2000;
export const CHUNK_COUNT = 8;

/** The size, in bytes, of the HOME ROM: chunks 0 and 1. */
const HOME_ROM_CHUNKS = 2;

/** One 8K chunk of a cartridge: its bytes, and whether the CPU can write them. */
export interface MemoryChunk {
  readonly data: Uint8Array;
  readonly writable: boolean;
}

/** A dock cartridge: per chunk, what it puts in each of the three banks (null
 *  where it has nothing). */
export interface DockCartridge {
  readonly name: string;
  /** The DOCK bank, selected with port 0xFF bit 7 clear. */
  readonly dock: readonly (MemoryChunk | null)[];
  /** EXROM chunks the cartridge overrides, selected with port 0xFF bit 7 set. */
  readonly exrom: readonly (MemoryChunk | null)[];
  /** HOME chunks the cartridge replaces (only 0 and 1 are used). */
  readonly home: readonly (MemoryChunk | null)[];
}

const NO_CHUNKS: readonly (MemoryChunk | null)[] = Object.freeze(new Array<MemoryChunk | null>(CHUNK_COUNT).fill(null));

export class TimexMmu {
  /** Port 0xF4: bit n set selects the alternate bank for chunk n. */
  f4 = 0;
  /** Port 0xFF bit 7: the alternate bank is the EXROM (true) or the DOCK (false). */
  exrom = false;

  /** The EXROM ROM: 8K, shown in every chunk that selects the EXROM. */
  readonly exromImage = new Uint8Array(CHUNK_SIZE);

  /** Per chunk: 1 when the CPU's writes land, 0 when they are discarded. Stable
   *  reference, for the write hot path. */
  readonly writable = new Uint8Array(CHUNK_COUNT);

  private cartridge: DockCartridge | null = null;
  /** Per chunk: 1 while the alternate bank's bytes are in the flat array. */
  private readonly engaged = new Uint8Array(CHUNK_COUNT);
  /** Per chunk: what the engaged alternate is, so a change of bank re-swaps it. */
  private readonly engagedExrom = new Uint8Array(CHUNK_COUNT);
  /** Per chunk: the engaged alternate's RAM store, or null (a ROM, or nothing). */
  private readonly altRam: (Uint8Array | null)[] = new Array<Uint8Array | null>(CHUNK_COUNT).fill(null);
  /** The HOME bytes of every engaged chunk. */
  private readonly shadow = new Uint8Array(CHUNK_SIZE * CHUNK_COUNT);

  constructor(private readonly flat: Uint8Array) {
    this.refreshWritable();
  }

  get cart(): DockCartridge | null { return this.cartridge; }

  /** Bit n set: chunk n currently shows the alternate bank. */
  get engagedMask(): number {
    let mask = 0;
    for (let i = 0; i < CHUNK_COUNT; i++) if (this.engaged[i] !== 0) mask |= 1 << i;
    return mask;
  }

  isEngaged(chunk: number): boolean { return this.engaged[chunk] !== 0; }

  /** The HOME bytes behind an engaged chunk (undefined behaviour otherwise). */
  shadowChunk(chunk: number): Uint8Array {
    return this.shadow.subarray(chunk * CHUNK_SIZE, (chunk + 1) * CHUNK_SIZE);
  }

  /** Put a cartridge in the dock, or take it out (null). The caller resets the machine. */
  setCartridge(cart: DockCartridge | null): void {
    this.release();
    this.cartridge = cart;
    this.engage();
  }

  /** Power-on state: nothing selected. Does not touch the flat array (a reset is
   *  about to rewrite it). */
  resetState(): void {
    this.f4 = 0;
    this.exrom = false;
    this.engaged.fill(0);
    this.engagedExrom.fill(0);
    this.altRam.fill(null);
    this.refreshWritable();
  }

  /** A write to port 0xF4 or to bit 7 of port 0xFF. */
  select(f4: number, exrom: boolean): void {
    this.f4 = f4 & 0xFF;
    this.exrom = exrom;
    this.update();
  }

  /**
   * Bring the flat array in line with the HOME replacement, `f4` and `exrom`:
   * after something rewrote the HOME bytes under a released mapper (a reset, a ROM
   * load, a snapshot).
   */
  engage(): void {
    this.applyHomeCartridge();
    this.update();
  }

  /**
   * Hand the HOME bytes back: every engaged chunk goes back to what it displaced,
   * and the alternate's RAM is saved. Leaves `f4` and `exrom` alone, so `engage()`
   * can put the mapping back.
   */
  release(): void {
    for (let i = 0; i < CHUNK_COUNT; i++) if (this.engaged[i] !== 0) this.swapOut(i);
    this.refreshWritable();
  }

  /** Save the RAM of the engaged alternates to their stores, leaving them engaged
   *  (a snapshot is about to read the cartridge). */
  flushAlternates(): void {
    for (let i = 0; i < CHUNK_COUNT; i++) {
      const ram = this.altRam[i];
      if (ram !== null) ram.set(this.flat.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    }
  }

  /** What chunk `i` would show from the alternate bank now. */
  private alternate(i: number): MemoryChunk | null {
    const cart = this.cartridge ?? { dock: NO_CHUNKS, exrom: NO_CHUNKS, home: NO_CHUNKS };
    return this.exrom ? cart.exrom[i] : cart.dock[i];
  }

  private update(): void {
    for (let i = 0; i < CHUNK_COUNT; i++) {
      const want = (this.f4 >> i) & 1;
      if (this.engaged[i] !== 0 && (want === 0 || this.engagedExrom[i] !== (this.exrom ? 1 : 0))) this.swapOut(i);
      if (want !== 0 && this.engaged[i] === 0) this.swapIn(i);
    }
    this.refreshWritable();
  }

  private swapIn(i: number): void {
    const at = i * CHUNK_SIZE;
    this.shadow.set(this.flat.subarray(at, at + CHUNK_SIZE), at);
    const alt = this.alternate(i);
    if (alt !== null) {
      this.flat.set(alt.data, at);
      this.altRam[i] = alt.writable ? alt.data : null;
    } else if (this.exrom) {
      this.flat.set(this.exromImage, at);   // the EXROM chip answers in every chunk
      this.altRam[i] = null;
    } else {
      this.flat.fill(0xFF, at, at + CHUNK_SIZE);   // nothing in the dock there
      this.altRam[i] = null;
    }
    this.engaged[i] = 1;
    this.engagedExrom[i] = this.exrom ? 1 : 0;
  }

  private swapOut(i: number): void {
    const at = i * CHUNK_SIZE;
    const ram = this.altRam[i];
    if (ram !== null) ram.set(this.flat.subarray(at, at + CHUNK_SIZE));
    this.flat.set(this.shadow.subarray(at, at + CHUNK_SIZE), at);
    this.engaged[i] = 0;
    this.altRam[i] = null;
  }

  /** Copy a cartridge's HOME replacement into the HOME ROM, wherever HOME lives now. */
  private applyHomeCartridge(): void {
    const cart = this.cartridge;
    if (cart === null) return;
    for (let i = 0; i < HOME_ROM_CHUNKS; i++) {
      const home = cart.home[i];
      if (home === null) continue;
      const at = i * CHUNK_SIZE;
      (this.engaged[i] !== 0 ? this.shadow : this.flat).set(home.data, at);
    }
  }

  private refreshWritable(): void {
    for (let i = 0; i < CHUNK_COUNT; i++) {
      if (this.engaged[i] !== 0) {
        this.writable[i] = this.altRam[i] !== null ? 1 : 0;
      } else if (i >= HOME_ROM_CHUNKS) {
        this.writable[i] = 1;   // HOME RAM
      } else {
        this.writable[i] = this.cartridge?.home[i]?.writable ? 1 : 0;   // HOME ROM, unless a cartridge made it RAM
      }
    }
  }
}
