/**
 * ZX Microdrive — a single tape-loop drive for the ZX Interface 1.
 *
 * A Microdrive is NOT a sectored disk: the cartridge is a continuous loop of
 * tape holding a fixed number of equal-length sectors that stream past the head
 * as the motor turns. The IF1 reads/writes one byte at a time through port 0xE7
 * and polls block boundaries (GAP / SYNC) through port 0xEF. This class models
 * one drive: the cartridge bytes plus the per-drive transfer state machine.
 * The Interface1 peripheral owns eight of these and the drive-select chain.
 *
 * Model verified against Fuse `peripherals/if1.c` (the `microdrive_t` FSM:
 * head_pos / transfered / max_bytes / pream[] / gap / sync) and the MDR
 * on-disk format + checksum from libspectrum `microdrive.c`.
 *
 * MDR cartridge file layout (see https://sinclair.wiki.zxnet.co.uk):
 *   N sectors × 543 bytes, then 1 write-protect flag byte (non-zero = WP).
 *   A full cartridge is 254 sectors → 254×543 + 1 = 137923 bytes.
 *   Each 543-byte sector = a 15-byte HEADER block + a 528-byte RECORD block:
 *     header   [0]   HDFLAG  = 1 (header marker)
 *              [1]   HDNUMB  = sector number (254..1)
 *              [2-3] unused
 *              [4-13] HDNAME = 10-byte cartridge name (space padded)
 *              [14]  HDCHK   = checksum of bytes 0..13
 *     record   [15]  RECFLG  = record flags
 *              [16]  RECNUM  = data block sequence number
 *              [17-18] RECLEN = data length ≤512 (LSB first)
 *              [19-28] RECNAM = 10-byte file name (space padded)
 *              [29]  DESCHK  = checksum of bytes 15..28
 *              [30-541] data = 512 bytes
 *              [542] DCHK    = checksum of the 512 data bytes
 */

/** Bytes per full sector on the loop (header block + record block). */
export const BLOCK_LEN = 543;
/** Header block length, and the descriptor length within the record block. */
export const HEAD_LEN = 15;
/** Data payload bytes within a record block. */
export const DATA_LEN = 512;
/** Default sectors laid down by FORMAT / a full cartridge. */
export const MAX_SECTORS = 254;

/** max_bytes for the 528-byte record sub-block (descriptor + data + checksum). */
const RECORD_MAX = HEAD_LEN + DATA_LEN + 1;
/** pream[] marker meaning "this block is formatted" (Fuse SYNC_OK). */
const SYNC_OK = 0xff;

/**
 * The IF1 microdrive checksum: the 8-bit sum of the covered bytes modulo 255.
 * Yields 0..254 and never 255 (the value the IF1 reports for a blank or corrupt
 * block). Equivalent to libspectrum's end-around-carry `DO_CHECK` macro.
 */
export function microdriveChecksum(data: Uint8Array, start = 0, len = data.length - start): number {
  let sum = 0;
  for (let i = 0; i < len; i++) sum += data[start + i];
  return sum % 255;
}

/** Write a 10-byte space-padded name field (truncating longer names). */
function writeName(buf: Uint8Array, off: number, name: string): void {
  for (let i = 0; i < 10; i++) {
    buf[off + i] = i < name.length ? name.charCodeAt(i) & 0xff : 0x20;
  }
}

export class Microdrive {
  /** Cartridge image: `numSectors × BLOCK_LEN` bytes, or null when empty. */
  private cartridge: Uint8Array | null = null;
  /** Number of sectors on the loop (≤ MAX_SECTORS). */
  numSectors = 0;
  /** Write-protect tab (trailing MDR flag byte; honoured by the IF1 status read). */
  writeProtected = false;
  /** Set whenever the IF1 writes to the cartridge — drives the "save?" prompt. */
  modified = false;

  // ── Transfer state machine (mirrors Fuse `microdrive_t`) ────────────────
  /** True while this drive's motor is selected by the IF1 drive-select chain. */
  motorOn = false;
  /** Byte offset of the head into the cartridge loop. */
  headPos = 0;
  /** Bytes transferred since the last restart() (the current block pass). */
  transfered = 0;
  /** Bytes to transfer in the current sub-block: HEAD_LEN or RECORD_MAX. */
  maxBytes = HEAD_LEN;
  /** Last byte read (returned again once the block is exhausted). */
  private last = 0xff;
  /** GAP / SYNC countdown timers driving the status-port block pattern. */
  private gap = 0;
  private sync = 0;
  /** Per-block "formatted" markers: headers at 0.., records at 256.. (Fuse). */
  private readonly pream = new Uint8Array(512);

  get inserted(): boolean { return this.cartridge !== null; }

  /** Eject the cartridge and clear all transfer state. */
  eject(): void {
    this.cartridge = null;
    this.numSectors = 0;
    this.writeProtected = false;
    this.modified = false;
    this.pream.fill(0);
    this.headPos = 0;
    this.transfered = 0;
    this.maxBytes = HEAD_LEN;
  }

  /** Mark every block of the inserted cartridge as formatted (Fuse if1_mdr_insert). */
  private markFormatted(): void {
    this.pream.fill(0);
    for (let i = this.numSectors; i > 0; i--) {
      this.pream[255 + i] = SYNC_OK; // record block i-1 → index 256..
      this.pream[i - 1] = SYNC_OK;   // header block i-1 → index 0..
    }
  }

  /** pream[] index for the block currently under the head (Fuse block formula). */
  private currentBlock(): number {
    return Math.floor(this.headPos / BLOCK_LEN) + (this.maxBytes === HEAD_LEN ? 0 : 256);
  }

  private cartLen(): number {
    return this.cartridge !== null ? this.cartridge.length : 0;
  }

  private incrementHead(): void {
    this.headPos++;
    if (this.headPos >= this.cartLen()) this.headPos = 0;
  }

  /**
   * Re-align the head to the start of a sub-block (offset 0 = header, offset
   * HEAD_LEN = record) and arm the byte counter for that sub-block. The IF1
   * calls this after every control-port write and status read.
   */
  restart(): void {
    const len = this.cartLen();
    if (len > 0) {
      while (this.headPos % BLOCK_LEN !== 0 && this.headPos % BLOCK_LEN !== HEAD_LEN) {
        this.incrementHead();
      }
    }
    this.transfered = 0;
    this.maxBytes = this.headPos % BLOCK_LEN === 0 ? HEAD_LEN : RECORD_MAX;
  }

  /** One drive's contribution to a data-port (0xE7) read: the byte under the head. */
  dataIn(): number {
    if (!this.motorOn || this.cartridge === null) return 0xff;
    if (this.transfered < this.maxBytes) {
      this.last = this.cartridge[this.headPos];
      this.incrementHead();
    }
    this.transfered++;
    return this.last;
  }

  /** One drive's contribution to a data-port (0xE7) write (preamble + payload). */
  dataOut(val: number): void {
    if (!this.motorOn || this.cartridge === null) return;
    const block = this.currentBlock();
    // The 12-byte preamble (10 × 0x00, 2 × 0xFF) marks the block formatted.
    if (this.transfered === 0 && val === 0x00) {
      this.pream[block] = 1;
    } else if (this.transfered > 0 && this.transfered < 10 && val === 0x00) {
      this.pream[block]++;
    } else if (this.transfered > 9 && this.transfered < 12 && val === 0xff) {
      this.pream[block]++;
    } else if (this.transfered === 12 && this.pream[block] === 12) {
      this.pream[block] = SYNC_OK;
    }
    // Bytes after the 12-byte preamble are the actual block payload.
    if (this.transfered > 11 && this.transfered < this.maxBytes + 12) {
      this.cartridge[this.headPos] = val & 0xff;
      this.incrementHead();
      this.modified = true;
    }
    this.transfered++;
  }

  /**
   * One drive's contribution (AND-mask) to a status-port (0xEF) read: pulls the
   * GAP/SYNC bits low while a formatted block passes the head, and the
   * write-protect bit low for a protected cartridge.
   */
  statusIn(): number {
    let ret = 0xff;
    if (!this.motorOn || this.cartridge === null) return ret;
    const block = this.currentBlock();
    if (this.pream[block] === SYNC_OK) {
      if (this.gap) {
        this.gap--;
      } else {
        ret &= 0xf9; // GAP (bit 2) and SYNC (bit 1) low
        if (this.sync) {
          this.sync--;
        } else {
          this.gap = 15;
          this.sync = 15;
        }
      }
    }
    if (this.writeProtected) ret &= 0xfe; // WP (bit 0) low
    return ret;
  }

  /**
   * Insert an MDR image: `sectors × BLOCK_LEN` bytes plus an optional trailing
   * write-protect flag byte. All blocks are assumed already formatted (matching
   * Fuse: the IF1 ROM revalidates checksums itself when it reads them).
   */
  loadMDR(data: Uint8Array): void {
    const sectors = Math.floor(data.length / BLOCK_LEN);
    this.numSectors = sectors;
    this.cartridge = data.slice(0, sectors * BLOCK_LEN);
    // A trailing byte beyond the sector data is the write-protect flag.
    this.writeProtected = data.length > sectors * BLOCK_LEN && data[sectors * BLOCK_LEN] !== 0;
    this.modified = false;
    this.markFormatted();
  }

  /** Export the cartridge as an MDR image (sectors + write-protect flag byte). */
  toMDR(): Uint8Array {
    const sectors = this.cartridge ?? new Uint8Array(0);
    const out = new Uint8Array(sectors.length + 1);
    out.set(sectors, 0);
    out[sectors.length] = this.writeProtected ? 1 : 0;
    return out;
  }

  /**
   * Lay down a freshly-formatted blank cartridge: MAX_SECTORS sectors, each with
   * a valid header (HDFLAG/HDNUMB/HDNAME/HDCHK) and an empty record descriptor
   * (RECLEN 0, valid DESCHK/DCHK) so it is usable without running FORMAT in BASIC.
   */
  format(name: string): void {
    const cart = new Uint8Array(MAX_SECTORS * BLOCK_LEN);
    for (let s = 0; s < MAX_SECTORS; s++) {
      const off = s * BLOCK_LEN;
      // Header block.
      cart[off] = 1;                              // HDFLAG
      cart[off + 1] = MAX_SECTORS - s;            // HDNUMB: 254 down to 1
      writeName(cart, off + 4, name);             // HDNAME
      cart[off + HEAD_LEN - 1] = microdriveChecksum(cart, off, HEAD_LEN - 1); // HDCHK
      // Record descriptor: empty record (RECFLG/RECNUM/RECLEN all 0, blank name).
      const rec = off + HEAD_LEN;
      writeName(cart, rec + 4, '');               // RECNAM = spaces
      cart[rec + HEAD_LEN - 1] = microdriveChecksum(cart, rec, HEAD_LEN - 1); // DESCHK
      // Data block is all zero; DCHK of 512 zero bytes is 0.
    }
    this.cartridge = cart;
    this.numSectors = MAX_SECTORS;
    this.writeProtected = false;
    this.modified = false;
    this.markFormatted();
  }
}
