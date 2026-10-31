/**
 * The shape of a snapshot byte stream, as the chips see it.
 *
 * Machine snapshots are written with `StateWriter` / `StateReader`
 * (`src/machines/shared/state-io.ts`). The commodity chips in `src/cores/` save
 * and restore their own state into the same stream, but a core may not import
 * the machine layer, so they are written against these two interfaces, which
 * the writer and reader satisfy structurally. Numbers are little-endian; f64
 * carries cycle counters and anything fractional.
 */

export interface StateSink {
  u8(v: number): void;
  u16(v: number): void;
  u32(v: number): void;
  i32(v: number): void;
  f64(v: number): void;
  bool(v: boolean): void;
  /** Bytes with no length: the reader must know how many to ask for. */
  raw(b: ArrayLike<number>): void;
  /** Length-prefixed bytes. */
  bytes(b: Uint8Array): void;
  str(s: string): void;
}

export interface StateSource {
  u8(): number;
  u16(): number;
  u32(): number;
  i32(): number;
  f64(): number;
  bool(): boolean;
  /** Fill `dst` from the next `dst.length` bytes. */
  rawInto(dst: Uint8Array): void;
  /** Length-prefixed bytes, copied; `max` guards a corrupt length. */
  bytes(max?: number): Uint8Array;
  str(): string;
}
