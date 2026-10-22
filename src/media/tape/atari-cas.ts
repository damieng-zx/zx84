/**
 * Atari 8-bit `.cas` cassette images (the "FUJI" chunk format).
 *
 * Pure format code (media layer). The program recorder that plays these
 * images lives with the Atari machine (`machines/atari/cassette.ts`).
 * Atari and MSX images share the `.cas` extension but nothing else; each
 * machine's media service decides which codec a file goes to.
 *
 * The file is a run of chunks, each with an 8-byte header:
 *
 *   0-3  chunk type, ASCII ('FUJI', 'baud', 'data', ...)
 *   4-5  payload length, little-endian
 *   6-7  aux value, little-endian
 *
 *   FUJI  first chunk; payload is a free-text tape description
 *   baud  aux = the baud rate of the data chunks that follow (600 standard)
 *   data  aux = the inter-record gap before this record, in milliseconds;
 *         payload = one SIO record as it was on tape
 *   fsk   aux = the gap before the block, in milliseconds; payload = 16-bit
 *         little-endian durations in units of 0.1 ms of a raw signal that
 *         alternates space (0) and mark (1), starting with space. Turbo and
 *         protected tapes whose blocks are not standard SIO records use it.
 *
 * The PWM chunk types (`pwms`, `pwmc`, `pwmd`, `pwml`) describe turbo
 * systems that need extra hardware in the recorder; they are counted and
 * skipped.
 *
 * A standard record is 132 bytes: two $55 speed-measurement bytes, a control
 * byte ($FC full record, $FA partial record whose last data byte is the
 * count, $FE end of file), 128 data bytes, and the SIO checksum (an 8-bit sum
 * with the carry added back in) of the 131 bytes before it.
 */

const HEADER = 8;
const ID_FUJI = 'FUJI';
const ID_BAUD = 'baud';
const ID_DATA = 'data';
const ID_FSK = 'fsk ';
const DEFAULT_BAUD = 600;

/** Control byte of a standard record. */
export const CAS_FULL = 0xFC;
export const CAS_PARTIAL = 0xFA;
export const CAS_EOF = 0xFE;

export interface AtariCasRecord {
  /** The record bytes as they were on tape, checksum included. */
  readonly data: Uint8Array;
  /** Baud rate in force for this record. */
  readonly baud: number;
  /** Inter-record gap before it, in milliseconds. */
  readonly gapMs: number;
}

/** A raw FSK block: the signal itself rather than SIO bytes. */
export interface AtariCasFsk {
  /** Durations of alternating space/mark levels, space first, in 0.1 ms. */
  readonly fsk: Uint16Array;
  /** Gap (mark) before the block, in milliseconds. */
  readonly gapMs: number;
}

/** One block of the tape signal, in the order the blocks are on tape. */
export type AtariCasBlock = AtariCasRecord | AtariCasFsk;

export function isFskBlock(b: AtariCasBlock): b is AtariCasFsk {
  return 'fsk' in b;
}

export interface AtariCasImage {
  readonly description: string;
  /** The SIO records (the `data` chunks), for record-level reads. */
  readonly records: readonly AtariCasRecord[];
  /** Every playable block, records and raw FSK blocks, in tape order. */
  readonly blocks: readonly AtariCasBlock[];
  /** Chunks of a type the recorder cannot play (PWM turbo signals). */
  readonly unsupportedChunks: number;
}

/** A file on the tape: the records up to and including an EOF record. */
export interface AtariCasFile {
  /** Index of its first record. */
  readonly first: number;
  /** Number of records, EOF included. */
  readonly records: number;
  /** Data bytes it carries (partial records count only their used bytes). */
  readonly bytes: number;
  /** The tape ran out before an EOF record (a boot tape usually ends so). */
  readonly unterminated: boolean;
}

function chunkId(data: Uint8Array, at: number): string {
  return String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
}

/** True when `data` starts with a FUJI chunk. */
export function isAtariCas(data: Uint8Array): boolean {
  return data.length >= HEADER && chunkId(data, 0) === ID_FUJI;
}

/** The SIO checksum: an 8-bit sum with the carry added back in. */
export function sioChecksum(bytes: Uint8Array, length = bytes.length): number {
  let sum = 0;
  for (let i = 0; i < length; i++) {
    sum += bytes[i];
    if (sum > 0xFF) sum = (sum & 0xFF) + 1;
  }
  return sum;
}

/** Parse a `.cas` image, or null if it is not one. */
export function parseAtariCas(data: Uint8Array): AtariCasImage | null {
  if (!isAtariCas(data)) return null;
  let description = '';
  let baud = DEFAULT_BAUD;
  let unsupported = 0;
  const records: AtariCasRecord[] = [];
  const blocks: AtariCasBlock[] = [];
  let at = 0;
  while (at + HEADER <= data.length) {
    const id = chunkId(data, at);
    const length = data[at + 4] | (data[at + 5] << 8);
    const aux = data[at + 6] | (data[at + 7] << 8);
    const start = at + HEADER;
    const end = Math.min(data.length, start + length);
    const payload = data.subarray(start, end);
    if (id === ID_FUJI) description = String.fromCharCode(...payload).replace(/\0+$/, '').trim();
    else if (id === ID_BAUD) baud = aux || DEFAULT_BAUD;
    else if (id === ID_DATA) {
      const record = { data: payload.slice(), baud, gapMs: aux };
      records.push(record);
      blocks.push(record);
    } else if (id === ID_FSK) {
      const fsk = new Uint16Array(payload.length >> 1);
      for (let i = 0; i < fsk.length; i++) fsk[i] = payload[i * 2] | (payload[i * 2 + 1] << 8);
      blocks.push({ fsk, gapMs: aux });
    } else unsupported++;
    at = start + length;
  }
  return { description, records, blocks, unsupportedChunks: unsupported };
}

/** Write an image back out: FUJI, then a baud chunk wherever the rate
 *  changes, then the records. */
export function writeAtariCas(image: { description: string; records: readonly AtariCasRecord[] }): Uint8Array {
  const parts: Uint8Array[] = [];
  const chunk = (id: string, aux: number, payload: Uint8Array) => {
    const head = new Uint8Array(HEADER);
    for (let i = 0; i < 4; i++) head[i] = id.charCodeAt(i);
    head[4] = payload.length & 0xFF;
    head[5] = (payload.length >> 8) & 0xFF;
    head[6] = aux & 0xFF;
    head[7] = (aux >> 8) & 0xFF;
    parts.push(head, payload);
  };
  chunk(ID_FUJI, 0, new Uint8Array([...image.description].map(c => c.charCodeAt(0) & 0xFF)));
  let baud = -1;
  for (const r of image.records) {
    if (r.baud !== baud) { chunk(ID_BAUD, r.baud, new Uint8Array(0)); baud = r.baud; }
    chunk(ID_DATA, r.gapMs, r.data);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Data bytes a standard record carries: 128, or the count in its last data
 *  byte for a partial record, or 0 for EOF / a non-standard record. */
function recordBytes(r: Uint8Array): number {
  if (r.length < 131) return 0;
  if (r[2] === CAS_FULL) return 128;
  if (r[2] === CAS_PARTIAL) return r[130];
  return 0;
}

/** Group the records into files, each ending at an EOF record. */
export function atariCasFiles(records: readonly AtariCasRecord[]): AtariCasFile[] {
  const files: AtariCasFile[] = [];
  let first = 0;
  let bytes = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i].data;
    bytes += recordBytes(r);
    if (r.length >= 3 && r[2] === CAS_EOF) {
      files.push({ first, records: i - first + 1, bytes, unterminated: false });
      first = i + 1;
      bytes = 0;
    }
  }
  if (first < records.length) {
    files.push({ first, records: records.length - first, bytes, unterminated: true });
  }
  return files;
}
