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
/** The tape routine's own exit (CTC reset, frame interrupt restored, RETI to
 *  the caller), where an instantly-completed SAVE request resumes. */
export const MTX_TAPE_EPILOGUE = 0x0B06;
/** Return address of the ROM SAVE's header request (CALL 0AAE at 0BA4). */
export const MTX_SAVE_HEADER_CALLER = 0x0BA7;

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

/** One chunk the ROM's tape routine wrote: where it came from, and the bytes. */
export interface MtxSavedChunk {
  readonly address: number;
  readonly data: Uint8Array;
}

/**
 * The logical stream of a SAVE: what the ROM tape routine was asked to write,
 * in order, as a later LOAD will ask for it — which is what a `.mtx` holds.
 *
 * SAVE and LOAD share the code that writes and reads the program body (from
 * 0BB0), so those requests line up one for one. The header does not: SAVE
 * writes a 20-byte block (0BA1: LD DE,0014) and LOAD asks for only the first
 * 18 (0B4F: LD DE,0012), the cassette skipping the rest when it looks for the
 * next leader. A logical stream has no leaders, so the header's last two
 * bytes are dropped here. SAVE's header request also starts a new program, so
 * the recording is always the latest SAVE.
 */
export class MtxTapeRecorder {
  private chunks: Uint8Array[] = [];

  /** Note one write request made from `caller` (the CALL's return address). */
  record(caller: number, data: Uint8Array): void {
    if (caller === MTX_SAVE_HEADER_CALLER) {
      this.chunks = [data.slice(0, MTX_FIRST_HEADER_LENGTH)];
    } else if (this.chunks.length > 0) {
      this.chunks.push(data.slice());
    }
  }

  /** The latest SAVE as `.mtx` bytes, or null when nothing has been saved. */
  bytes(): Uint8Array | null {
    if (this.chunks.length === 0) return null;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of this.chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  reset(): void { this.chunks = []; }
}
