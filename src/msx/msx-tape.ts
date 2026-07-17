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

/** A block of a `.cas` image, for the tape-pane listing. */
export interface CasBlock {
  /** True for a 16-byte file-header block, false for a data block. */
  header: boolean;
  /** Main line, e.g. `Header "GAME"` or `Data`. */
  title: string;
  /** Secondary line, e.g. `BASIC file` or `2048 bytes`. */
  detail: string;
  /** File name (header blocks only). */
  name?: string;
  /** File type — BASIC / Binary / ASCII (header blocks only). */
  type?: string;
  /** Size of this block's payload in bytes. */
  size: number;
}

/** MSX file-header type markers (10 identical bytes lead a header block). */
const CAS_FILE_TYPE: Record<number, string> = { 0xD3: 'BASIC', 0xD0: 'Binary', 0xEA: 'ASCII' };

/**
 * Parse a `.cas` image into its logical blocks (header + data), the way the
 * tape pane lists TAP/TZX blocks. Each 8-byte sync ID (on an 8-byte boundary)
 * starts a block that runs to the next ID or end of file. A 16-byte block led by
 * ten identical D3/D0/EA bytes is a file header (its last 6 bytes are the name);
 * everything else is data.
 */
export function parseCasBlocks(data: Uint8Array): CasBlock[] {
  const isIdAt = (p: number): boolean => {
    if (p + 8 > data.length) return false;
    for (let i = 0; i < 8; i++) if (data[p + i] !== CAS_HEADER[i]) return false;
    return true;
  };
  const syncs: number[] = [];
  for (let p = 0; p + 8 <= data.length; p += 8) if (isIdAt(p)) syncs.push(p);

  const out: CasBlock[] = [];
  for (let i = 0; i < syncs.length; i++) {
    const start = syncs[i] + 8;
    const end = i + 1 < syncs.length ? syncs[i + 1] : data.length;
    const chunk = data.subarray(start, end);
    const marker = chunk.length >= 16 ? CAS_FILE_TYPE[chunk[0]] : undefined;
    let isHeader = false;
    if (marker) {
      isHeader = true;
      for (let k = 1; k < 10; k++) if (chunk[k] !== chunk[0]) { isHeader = false; break; }
    }
    if (isHeader) {
      let name = '';
      for (let k = 10; k < 16; k++) name += String.fromCharCode(chunk[k]);
      name = name.trimEnd();
      out.push({ header: true, title: `Header "${name}"`, detail: `${marker} file`, name, type: marker, size: chunk.length });
    } else {
      out.push({ header: false, title: 'Data', detail: `${chunk.length} bytes`, size: chunk.length });
    }
  }
  return out;
}

export class MsxCassette {
  private data: Uint8Array = new Uint8Array(0);
  private pos = 0;
  loaded = false;
  name = '';

  /** Byte offsets of each block's sync ID, in order (one per CasBlock). */
  private syncOffsets: number[] = [];

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
   * TAPIN: return the next byte of the current block, or -1 at end of stream.
   * The caller (BIOS) reads exactly as many bytes as the block defines, so we
   * hand out the stream sequentially.
   */
  readByte(): number {
    if (this.pos >= this.data.length) return -1;
    return this.data[this.pos++];
  }
}
