/**
 * Amstrad Plus cartridge (.CPR) codec.
 *
 * The .CPR container is a RIFF/`AMS!` file holding up to 32 `cbNN` chunks —
 * one per 16 KB cartridge ROM page. Each chunk's ID is the literal four bytes
 * `cb` followed by an ASCII two-digit page number (`cb00`..`cb31`); the data
 * payload is zero-padded to (or truncated to) exactly 16 KB per page.
 *
 * Used by the CPC 6128Plus and the GX4000 — both boot from cartridge and have
 * no on-board ROMs. The Burnin' Rubber cartridge (shipped with the 6128Plus)
 * lays the system out as:
 *   page 0  — Firmware (OS 4)
 *   page 1  — BASIC 1.1     (selected by OUT &DFxx, 0; the "logical 0" ROM)
 *   page 2  — unused
 *   page 3  — AmsDOS        (selected by OUT &DFxx, 7; the "logical 7" ROM)
 *   pages 4-7 — game
 *
 * Source: CPCWiki Cartridge + Grimware AMS! documentation. Pure module —
 * imports only `Uint8Array` and the standard library; mirrors the layout of
 * `media/floppy/*.ts`.
 */

/** Each cartridge ROM page is exactly 16 KB. */
export const CPR_PAGE_SIZE = 0x4000;
/** Maximum number of pages a cartridge can hold (32 × 16 KB = 512 KB). */
export const CPR_MAX_PAGES = 32;

/** RIFF header magic: 'RIFF' + size + 'AMS!' form type. */
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];      // 'RIFF'
const AMS_FORM = [0x41, 0x4D, 0x53, 0x21];         // 'AMS!'

/** sniff: true if `data` looks like a .CPR (RIFF/AMS!) image. */
export function isCpr(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  for (let i = 0; i < 4; i++) {
    if (data[i] !== RIFF_MAGIC[i]) return false;
    if (data[i + 8] !== AMS_FORM[i]) return false;
  }
  return true;
}

/** Decode the 4-byte ASCII chunk ID at `offset` into a 'cbNN' string. */
function chunkIdAt(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

/** Zero-pad / truncate a chunk's payload to exactly 16 KB so the page-indexed
 *  array is uniformly sized — the CPC's ROM select logic always reads full
 *  16 KB pages. */
function toPage(raw: Uint8Array): Uint8Array {
  const page = new Uint8Array(CPR_PAGE_SIZE);
  page.set(raw.subarray(0, CPR_PAGE_SIZE));
  return page;
}

/**
 * Parse a .CPR image into a sparse array of 32 cartridge pages. Pages that
 * are absent in the file stay `undefined` — software that selects them reads
 * 0xFF (open bus) on real hardware, which is what an undefined page in the
 * cartridge array models naturally.
 *
 * Throws if the data is not a RIFF/`AMS!` image or if a chunk header is
 * malformed.
 */
export function parseCpr(data: Uint8Array): (Uint8Array | undefined)[] {
  if (!isCpr(data)) {
    throw new Error('Not a CPR image (missing RIFF/AMS! signature)');
  }
  const pages: (Uint8Array | undefined)[] = new Array(CPR_MAX_PAGES).fill(undefined);
  // Walk the chunk list starting after the 12-byte RIFF header. Each chunk:
  //   4 bytes chunk ID ('cbNN') + 4 bytes little-endian size + payload bytes.
  let off = 12;
  while (off + 8 <= data.length) {
    const id = chunkIdAt(data, off);
    // Decode as unsigned: a signed interpretation of the sign bit would make
    // `size` negative, pass every bound below, and walk `off` backwards off
    // the start of the buffer — stalling this loop forever.
    const size = (data[off + 4] | (data[off + 5] << 8) | (data[off + 6] << 16) | (data[off + 7] << 24)) >>> 0;
    off += 8;
    if (off + size > data.length) break;     // truncated file — accept what we have

    // Decode 'cbNN' into a page index. The first two chars must be 'cb'; the
    // next two are an ASCII two-digit decimal ('00'..'31').
    if (id.charCodeAt(0) === 0x63 && id.charCodeAt(1) === 0x62) {
      const tens = id.charCodeAt(2) - 0x30;
      const ones = id.charCodeAt(3) - 0x30;
      if (tens >= 0 && tens <= 3 && ones >= 0 && ones <= 9) {
        const page = tens * 10 + ones;
        if (page < CPR_MAX_PAGES) {
          pages[page] = toPage(data.subarray(off, off + size));
        }
      }
    }
    // Chunks other than 'cbNN' (e.g. 'RIFF' trailing chunks) are skipped.
    off += size + (size & 1);     // RIFF chunks are word-aligned (pad to even)
  }
  return pages;
}

/**
 * Pack the reverse direction — serialize a sparse 32-page cartridge back into
 * a RIFF/`AMS!` byte image. Used by the snapshot writer (Phase 6) and any
 * future "save cartridge" UI. Absent pages are omitted from the file.
 */
export function writeCpr(pages: ReadonlyArray<Uint8Array | undefined>): Uint8Array {
  const chunks: { id: string; data: Uint8Array }[] = [];
  let totalPayload = 0;
  for (let i = 0; i < CPR_MAX_PAGES; i++) {
    const page = pages[i];
    if (!page) continue;
    const id = 'cb' + (i < 10 ? '0' + i : '' + i);
    chunks.push({ id, data: page });
    totalPayload += 8 + page.length + (page.length & 1);
  }
  const out = new Uint8Array(12 + totalPayload);
  // RIFF header
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46;   // 'RIFF'
  const riffSize = 4 + totalPayload;                             // 'AMS!' + chunks
  out[4] = riffSize & 0xFF; out[5] = (riffSize >> 8) & 0xFF;
  out[6] = (riffSize >> 16) & 0xFF; out[7] = (riffSize >> 24) & 0xFF;
  out[8] = 0x41; out[9] = 0x4D; out[10] = 0x53; out[11] = 0x21; // 'AMS!'
  let off = 12;
  for (const c of chunks) {
    out[off++] = c.id.charCodeAt(0);
    out[off++] = c.id.charCodeAt(1);
    out[off++] = c.id.charCodeAt(2);
    out[off++] = c.id.charCodeAt(3);
    const len = c.data.length;
    out[off++] = len & 0xFF;
    out[off++] = (len >> 8) & 0xFF;
    out[off++] = (len >> 16) & 0xFF;
    out[off++] = (len >> 24) & 0xFF;
    out.set(c.data, off);
    off += len;
    if (len & 1) off++;    // word-align
  }
  return out;
}
