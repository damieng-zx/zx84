/**
 * Binary state writer/reader for machine snapshots.
 *
 * A snapshot is a sequence of tagged sections, each a four-character tag, a
 * u32 length and its payload, so a reader can check it is where it expects to
 * be and a later version can append fields to a section without breaking
 * older readers (a section reader that is asked for more than the section
 * holds throws; one that stops early is fine). Numbers are little-endian;
 * cycle counters and POKEY's event times are f64, since they run past 2^32
 * and POKEY uses +/-Infinity for "never".
 */

export class StateWriter {
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private need(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void { this.need(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  u16(v: number): void { this.need(2); this.view.setUint16(this.pos, v, true); this.pos += 2; }
  u32(v: number): void { this.need(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  i32(v: number): void { this.need(4); this.view.setInt32(this.pos, v, true); this.pos += 4; }
  f64(v: number): void { this.need(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; }
  bool(v: boolean): void { this.u8(v ? 1 : 0); }

  /** Bytes with no length: the reader must know how many to ask for. */
  raw(b: ArrayLike<number>): void {
    this.need(b.length);
    this.buf.set(b as ArrayLike<number>, this.pos);
    this.pos += b.length;
  }

  /** Length-prefixed bytes. */
  bytes(b: Uint8Array): void { this.u32(b.length); this.raw(b); }

  str(s: string): void { this.bytes(new TextEncoder().encode(s)); }

  f64s(a: ArrayLike<number>): void { for (let i = 0; i < a.length; i++) this.f64(a[i]); }

  /** A tagged section: `body` writes into the same writer; the length is
   *  patched in afterwards. */
  section(tag: string, body: () => void): void {
    if (tag.length !== 4) throw new Error(`Section tag must be four characters: ${tag}`);
    this.raw(Uint8Array.from(tag, c => c.charCodeAt(0)));
    const at = this.pos;
    this.u32(0);
    body();
    this.view.setUint32(at, this.pos - at - 4, true);
  }

  finish(): Uint8Array { return this.buf.slice(0, this.pos); }
}

export class StateReader {
  private readonly view: DataView;
  private pos = 0;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number { return this.data.length - this.pos; }

  private take(n: number): number {
    if (n < 0 || this.pos + n > this.data.length) throw new Error('Snapshot is truncated');
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(): number { return this.view.getUint8(this.take(1)); }
  u16(): number { return this.view.getUint16(this.take(2), true); }
  u32(): number { return this.view.getUint32(this.take(4), true); }
  i32(): number { return this.view.getInt32(this.take(4), true); }
  f64(): number { return this.view.getFloat64(this.take(8), true); }
  bool(): boolean { return this.u8() !== 0; }

  /** Fill `dst` from the next `dst.length` bytes. */
  rawInto(dst: Uint8Array): void {
    const at = this.take(dst.length);
    dst.set(this.data.subarray(at, at + dst.length));
  }

  /** Length-prefixed bytes, copied. `max` guards a corrupt length. */
  bytes(max = 1 << 26): Uint8Array {
    const n = this.u32();
    if (n > max) throw new Error('Snapshot is corrupt');
    const at = this.take(n);
    return this.data.slice(at, at + n);
  }

  str(): string { return new TextDecoder().decode(this.bytes(1 << 16)); }

  f64sInto(dst: Float64Array | number[]): void {
    for (let i = 0; i < dst.length; i++) dst[i] = this.f64();
  }

  /** The next section, which must carry `tag`. */
  section(tag: string): StateReader {
    const got = String.fromCharCode(...this.data.subarray(this.pos, this.pos + 4));
    if (got !== tag) throw new Error(`Snapshot is corrupt (expected ${tag}, found ${got})`);
    this.take(4);
    const len = this.u32();
    const at = this.take(len);
    return new StateReader(this.data.subarray(at, at + len));
  }

  /** True if the next section carries `tag` (without consuming it). */
  peekSection(tag: string): boolean {
    if (this.remaining < 8) return false;
    return String.fromCharCode(...this.data.subarray(this.pos, this.pos + 4)) === tag;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (the zip/PNG polynomial). */
export function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
