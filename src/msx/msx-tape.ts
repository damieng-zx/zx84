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
 *
 * The BIOS caller (CLOAD/BLOAD, or a program CALLing the routines) drives the
 * byte counts, so we just serve the stream sequentially. Custom turbo loaders
 * that sample the cassette port directly are not covered — a pulse-level engine
 * would be a later addition; those fall through and simply don't load.
 *
 * References: MSX2 Technical Handbook ch.5 (cassette BIOS); MSX Wiki
 * "Emulation related file formats" (.cas layout).
 */

/** BIOS main-ROM cassette entry points (jump-table addresses). */
export const MSX_TAPION = 0x00E1;
export const MSX_TAPIN = 0x00E4;

/** The 8-byte `.cas` block header ID (stands in for the sync tone). */
const CAS_HEADER = [0x1F, 0xA6, 0xDE, 0xBA, 0xCC, 0x13, 0x7D, 0x74];

export class MsxCassette {
  private data: Uint8Array = new Uint8Array(0);
  private pos = 0;
  loaded = false;
  name = '';

  /** Mount a `.cas` image and rewind to the start. */
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
   * TAPIN: return the next byte of the current block, or -1 at end of stream.
   * The caller (BIOS) reads exactly as many bytes as the block defines, so we
   * hand out the stream sequentially.
   */
  readByte(): number {
    if (this.pos >= this.data.length) return -1;
    return this.data[this.pos++];
  }
}
