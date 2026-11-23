/**
 * Oric-1 / Oric Atmos `.tap` cassette images.
 *
 * A `.tap` is **not** audio: it is the byte stream the ROM's loader sees after
 * demodulating the tape, which is why loading one is instant once the bytes are
 * in hand. Each file on the tape is:
 *
 *   $16 × N   leader (three or four in practice, "at least eight" per the docs)
 *   $24       sync marker
 *   9 bytes   header
 *   name…     NUL-terminated, at most 17 characters
 *   data      end - start + 1 bytes
 *
 * and files are simply concatenated, each with its own leader.
 *
 * The header, as the ROM reads it:
 *
 *   [0] [1]   not used by the loader
 *   [2]       file type: $00 tokenised BASIC, $80 machine code
 *   [3]       autorun flag: $C7 runs it after loading, $00 leaves it be
 *   [4] [5]   end address, big-endian (inclusive)
 *   [6] [7]   start address, big-endian
 *   [8]       not used by the loader
 *
 * The payload's length is therefore `end - start + 1`, which is why an image
 * with a reversed range is corrupt and is refused rather than truncated.
 */

/** Leader byte repeated before each file. */
export const ORIC_TAP_LEADER = 0x16;
/** Marks the end of the leader and the start of the header. */
export const ORIC_TAP_SYNC = 0x24;
/** Header length after the sync byte. */
export const ORIC_TAP_HEADER_LEN = 9;
/** The longest name the ROM's cassette commands accept. */
export const ORIC_TAP_MAX_NAME = 17;
/** OSDK's default leader length. */
export const ORIC_TAP_DEFAULT_LEADER = 3;
/** Autorun flag values. */
export const ORIC_TAP_AUTORUN = 0xC7;

/** A file on an Oric tape. */
export interface OricTapFile {
  /** The file type byte: `$00` BASIC, `$80` machine code. */
  readonly type: number;
  /** Whether the ROM runs the file after loading it. */
  readonly autorun: boolean;
  /** First address the payload loads to. */
  readonly start: number;
  /** Last address, inclusive. */
  readonly end: number;
  /** The name, without its terminator. */
  readonly name: string;
  /** The payload exactly as stored. */
  readonly data: Uint8Array;
  /** Leader bytes before this file, preserved for a faithful round trip. */
  readonly leaderLength: number;
}

/** True when `type` is one of the two the ROM's loader understands. */
export function isBasicFile(file: OricTapFile): boolean {
  return file.type === 0x00;
}

/**
 * Decode every file in a `.tap`. Throws with a message fit to show when the
 * image is not a well-formed Oric tape: a missing leader, a missing sync byte,
 * a truncated header or payload, a name with no terminator, or a reversed
 * address range.
 */
export function parseOricTap(bytes: Uint8Array): OricTapFile[] {
  const files: OricTapFile[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const fileAt = pos;
    while (pos < bytes.length && bytes[pos] === ORIC_TAP_LEADER) pos++;
    const leaderLength = pos - fileAt;
    if (leaderLength === 0) {
      throw new Error(`Not an Oric tape: no leader byte at $${fileAt.toString(16)}`);
    }
    if (pos >= bytes.length) break;             // trailing leader, no file
    if (bytes[pos] !== ORIC_TAP_SYNC) {
      throw new Error(
        `Not an Oric tape: expected the $${ORIC_TAP_SYNC.toString(16)} sync byte at ` +
        `$${pos.toString(16)}, found $${bytes[pos].toString(16)}`);
    }
    pos++;
    if (bytes.length - pos < ORIC_TAP_HEADER_LEN) {
      throw new Error(`Oric tape is truncated: the header at $${pos.toString(16)} is incomplete`);
    }
    const header = bytes.subarray(pos, pos + ORIC_TAP_HEADER_LEN);
    pos += ORIC_TAP_HEADER_LEN;

    const nameAt = pos;
    let nameEnd = -1;
    for (let i = 0; i <= ORIC_TAP_MAX_NAME && pos + i < bytes.length; i++) {
      if (bytes[pos + i] === 0) { nameEnd = pos + i; break; }
    }
    if (nameEnd < 0) {
      throw new Error(`Oric tape has an unterminated name at $${nameAt.toString(16)}`);
    }
    const name = latin1(bytes.subarray(nameAt, nameEnd));
    pos = nameEnd + 1;

    const start = (header[6] << 8) | header[7];
    const end = (header[4] << 8) | header[5];
    if (end < start) {
      throw new Error(`Oric tape file "${name}" has a reversed address range (${start}-${end})`);
    }
    const length = end - start + 1;
    if (bytes.length - pos < length) {
      throw new Error(
        `Oric tape file "${name}" is truncated: needs ${length} bytes, has ${bytes.length - pos}`);
    }
    files.push({
      type: header[2],
      autorun: header[3] !== 0,
      start,
      end,
      name,
      data: bytes.slice(pos, pos + length),
      leaderLength,
    });
    pos += length;
  }
  return files;
}

/** True when `bytes` starts like an Oric tape: a leader then a sync byte. */
export function isOricTap(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length && bytes[i] === ORIC_TAP_LEADER) i++;
  return i > 0 && i < bytes.length && bytes[i] === ORIC_TAP_SYNC;
}

/**
 * Build a `.tap` from files. A name over 17 characters or containing a NUL is
 * refused, as is a payload that does not match its address range — the same
 * things the ROM would refuse.
 */
export function buildOricTap(files: readonly OricTapFile[]): Uint8Array {
  const parts: number[] = [];
  for (const file of files) {
    if (file.name.length > ORIC_TAP_MAX_NAME) {
      throw new Error(`Oric tape names are at most ${ORIC_TAP_MAX_NAME} characters: "${file.name}"`);
    }
    if (file.name.includes('\0')) throw new Error('Oric tape names may not contain NUL');
    if (file.data.length === 0) throw new Error(`Oric tape file "${file.name}" is empty`);
    if (file.end - file.start + 1 !== file.data.length) {
      throw new Error(
        `Oric tape file "${file.name}" declares ${file.start}-${file.end} but carries ` +
        `${file.data.length} bytes`);
    }
    const leader = Math.max(1, file.leaderLength);
    for (let i = 0; i < leader; i++) parts.push(ORIC_TAP_LEADER);
    parts.push(ORIC_TAP_SYNC);
    parts.push(
      0, 0,
      file.type & 0xFF,
      file.autorun ? ORIC_TAP_AUTORUN : 0,
      (file.end >> 8) & 0xFF, file.end & 0xFF,
      (file.start >> 8) & 0xFF, file.start & 0xFF,
      0,
    );
    for (const ch of file.name) parts.push(ch.charCodeAt(0) & 0xFF);
    parts.push(0);
    parts.push(...file.data);
  }
  return Uint8Array.from(parts);
}

/** A BASIC or machine-code file wrapped as a one-file tape. */
export function oricTapFor(
  name: string,
  start: number,
  data: Uint8Array,
  options: { readonly machineCode?: boolean; readonly autorun?: boolean } = {},
): Uint8Array {
  return buildOricTap([{
    type: options.machineCode ? 0x80 : 0x00,
    autorun: options.autorun ?? false,
    start,
    end: start + data.length - 1,
    name,
    data,
    leaderLength: ORIC_TAP_DEFAULT_LEADER,
  }]);
}

/** Latin-1 bytes as a string, which is what an Oric name is. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}
