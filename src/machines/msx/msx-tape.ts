/**
 * MSX cassette (.cas) — BIOS-trap instant loader.
 *
 * MSX `.cas` files are a logical byte stream (not pulse-level audio): each block
 * is preceded by an 8-byte header ID `1F A6 DE BA CC 13 7D 74` on an 8-byte
 * boundary, standing in for the long sync tone. Rather than synthesise FSK audio
 * we intercept the two BIOS load routines and feed the bytes straight in:
 *
 *   TAPION (0x00E1) — "read until a header is found". Returns CY set on failure.
 *                     We skip to the next 8-byte ID and position just past it.
 *   TAPIN  (0x00E4) — "read one byte". Returns the byte in A, CY set at EOF.
 *   TAPOON (0x00EA) — "start writing a block": we emit the 8-byte sync ID.
 *   TAPOUT (0x00ED) — "write one byte" from A. Both return CY clear.
 *
 * Saved bytes collect in a separate recording (see recorded()), offered by
 * the Save menu as a .cas file.
 *
 * The BIOS caller (CLOAD/BLOAD, or a program CALLing the routines) drives the
 * byte counts, so we just serve the stream sequentially. Custom turbo loaders
 * that sample the cassette port directly are not covered — a pulse-level engine
 * would be a later addition; those fall through and simply don't load.
 *
 * References: MSX2 Technical Handbook ch.5 (cassette BIOS); MSX Wiki
 * "Emulation related file formats" (.cas layout).
 */

import { CAS_HEADER } from '@/media/tape/cas.ts';

/** BIOS main-ROM cassette entry points (jump-table addresses). */
export const MSX_TAPION = 0x00E1;
export const MSX_TAPIN = 0x00E4;
export const MSX_TAPOON = 0x00EA;
export const MSX_TAPOUT = 0x00ED;

// The `.cas` block parser + types are media-layer format code; re-exported so
// existing machine-side imports keep working.
export { parseCasBlocks, type CasBlock } from '@/media/tape/cas.ts';

export class MsxCassette {
  private data: Uint8Array = new Uint8Array(0);
  private pos = 0;
  loaded = false;
  name = '';

  /** Byte offsets of each block's sync ID, in order (one per CasBlock). */
  private syncOffsets: number[] = [];

  /** What the machine has saved (TAPOON/TAPOUT) since the last reset, as a
   *  growing .cas byte stream. */
  private rec = new Uint8Array(0x1000);
  private recLen = 0;

  /** Mount a `.cas` image and rewind to the start. */
  mount(data: Uint8Array, name = ''): void {
    this.data = data;
    this.pos = 0;
    this.loaded = data.length > 0;
    this.name = name;
    this.syncOffsets = [];
    for (let p = 0; p + 8 <= data.length; p += 8) if (this.isHeaderAt(p)) this.syncOffsets.push(p);
  }

  eject(): void {
    this.data = new Uint8Array(0);
    this.pos = 0;
    this.loaded = false;
    this.name = '';
    this.syncOffsets = [];
  }

  /** Index of the block currently being read (matches the CasBlock list order),
   *  or -1 before the first block. Derived from the byte read position. */
  currentBlock(): number {
    let idx = -1;
    for (let i = 0; i < this.syncOffsets.length; i++) {
      if (this.syncOffsets[i] <= this.pos) idx = i; else break;
    }
    return idx;
  }

  rewind(): void { this.pos = 0; }

  /** The raw mounted `.cas` bytes (for the per-platform tape stash). */
  getData(): Uint8Array { return this.data; }

  /** True if the 8-byte header ID begins at offset `p`. */
  private isHeaderAt(p: number): boolean {
    if (p + 8 > this.data.length) return false;
    for (let i = 0; i < 8; i++) if (this.data[p + i] !== CAS_HEADER[i]) return false;
    return true;
  }

  /**
   * TAPION: advance to the next block header (searched only at 8-byte-aligned
   * offsets, as the format requires) and position just past it. Returns false if
   * no further header exists (→ BIOS reports failure).
   */
  findHeader(): boolean {
    let p = (this.pos + 7) & ~7;   // round up to the next 8-byte boundary
    for (; p + 8 <= this.data.length; p += 8) {
      if (this.isHeaderAt(p)) { this.pos = p + 8; return true; }
    }
    this.pos = this.data.length;
    return false;
  }

  /**
   * TAPOON: start a saved block. Pad the stream with zeros to an 8-byte
   * boundary and write the sync ID, as .cas requires (the long/short leader
   * choice has no byte-level representation).
   */
  beginRecordBlock(): void {
    while (this.recLen & 7) this.recordByte(0x00);
    for (const b of CAS_HEADER) this.recordByte(b);
  }

  /** TAPOUT: append one saved byte. */
  recordByte(b: number): void {
    if (this.recLen === this.rec.length) {
      const grown = new Uint8Array(this.rec.length * 2);
      grown.set(this.rec);
      this.rec = grown;
    }
    this.rec[this.recLen++] = b & 0xFF;
  }

  /** The saved .cas stream, or null if nothing has been saved. */
  recorded(): Uint8Array | null {
    return this.recLen > 0 ? this.rec.slice(0, this.recLen) : null;
  }

  /** Forget everything saved (machine reset). */
  clearRecording(): void { this.recLen = 0; }

  /**
   * TAPIN: return the next byte of the current block, or -1 at end of stream.
   * The caller (BIOS) reads exactly as many bytes as the block defines, so we
   * hand out the stream sequentially.
   */
  readByte(): number {
    if (this.pos >= this.data.length) return -1;
    return this.data[this.pos++];
  }
}
