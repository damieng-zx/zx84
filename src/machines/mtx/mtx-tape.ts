/**
 * MTX logical cassette stream served to the ROM tape routine.
 *
 * `.mtx` images contain exactly the bytes that ROM LOAD/VERIFY requests, with
 * no pulse timings or per-block framing. The ROM supplies each destination and
 * byte count, so the cassette only needs a sequential cursor.
 */

export const MTX_TAPE_ROUTINE = 0x0AAE;
export const MTX_TAPE_RETURN = 0x0AB0;
export const MTX_TAPE_FAILURE = 0x0ADB;
export const MTX_FIRST_HEADER_ADDRESS = 0xC011;
export const MTX_FIRST_HEADER_LENGTH = 18;

export class MtxCassette {
  private data: Uint8Array = new Uint8Array(0);
  private pos = 0;
  loaded = false;
  name = '';

  mount(data: Uint8Array, name = ''): void {
    this.data = data;
    this.pos = 0;
    this.loaded = data.length > 0;
    this.name = name;
  }

  eject(): void {
    this.data = new Uint8Array(0);
    this.pos = 0;
    this.loaded = false;
    this.name = '';
  }

  rewind(): void { this.pos = 0; }
  getData(): Uint8Array { return this.data; }
  currentBlock(): number { return this.loaded ? 0 : -1; }

  /** Read and consume one ROM-requested chunk, or null at a short image. */
  readChunk(length: number): Uint8Array | null {
    if (length < 0 || this.pos + length > this.data.length) return null;
    const chunk = this.data.subarray(this.pos, this.pos + length);
    this.pos += length;
    return chunk;
  }

  /** Compare and consume one ROM-requested chunk. null means short image. */
  verifyChunk(expected: Uint8Array): boolean | null {
    const actual = this.readChunk(expected.length);
    if (!actual) return null;
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) return false;
    }
    return true;
  }
}
