/**
 * Jupiter Ace tape format (jupiter-ace.co.uk doc_AceTapeFormat, MAME
 * lib/formats/ace_tap.cpp).
 *
 * An Ace .tap is a sequence of [len16][bytes] chunks — but unlike a Spectrum
 * TAP, chunks carry NO flag byte of their own. The block type is implied by
 * the chunk length (0x001A = header) AND by position: a file is always a
 * header followed by its data, so the chunk after a header is that data
 * whatever its length. A 25-byte payload plus its checksum is itself a
 * 0x001A chunk, and calling that one a header (as MAME's ace_tap.cpp
 * length-only rule does) hands the ROM a 0x00 flag where it wants 0xFF: it
 * fails the flag test at 0x18DC and goes back to hunting for a header, so
 * the load stalls. The flag is synthesized from the decision (0x00 header,
 * 0xFF data) and the chunk bytes follow verbatim, the last of them being the
 * loader's checksum, part of the received stream.
 *
 * Header payload (25 bytes + trailing checksum = the 26-byte chunk):
 *
 *   +0     byte   file type: 0 = dictionary, non-zero = bytes file
 *   +1-10  10 bytes filename, padded with spaces
 *   +11-12 2 bytes length of file (LE)
 *   +13-14 2 bytes start address (15441 for a dictionary)
 *   +15-24 2 bytes each: current word, CURRENT, CONTEXT, VOCLNK, STKBOT
 *
 * Pulse geometry — read off the ROM's own SAVE routine (0x1820-0x189A), the
 * definitive statement of what an Ace tape looks like. Its instruction
 * timings give:
 *
 *   pilot  2011T half-cycles — LD B,97 (7) + DJNZ×151 (150×13+8) + OUT (11)
 *          + XOR (7) + INC L (4) + JR NZ (12) + JR NZ (12) per OUT at
 *          0x183B; 8192 of them per header, 1024 per data block
 *   sync   601T (0x1845's DJNZ×43) then 791T (0x184C's DJNZ×59)
 *   bit 0  two ~801T half-cycles   bit 1  two ~1591T half-cycles — the
 *          0x185C loop: DJNZ×58 (749) + 12T when the carry is clear, or
 *          + JR NC (7) + LD B,3D (7) + DJNZ×61 (788) when it is set. The
 *          halves alternate 801T/802T as B drops by one between bits, so
 *          the deck plays the 801T/1591T representative of each.
 *
 * TWO edges per bit, exactly like the Spectrum: the loader's per-bit
 * measurement at 0x18FC calls 0x1911, which times one edge and then falls
 * through into the single-edge routine at 0x1915 to time a second, so it
 * measures a full cycle against a 59T sampling loop (B based at 0xC7,
 * threshold 0xE2). A one-edge-per-bit waveform cannot load at all: two wide
 * edges overflow B (based at 0xB8, wrapping after ~71 passes) and the pilot
 * filter at 0x18BA never accepts its 256 cycles.
 *
 * In the deck's 3.5MHz-referenced units these sit within a few T of the
 * Spectrum's own standard timings (2166/647/852/863/1713 against
 * 2168/667/735/855/1710) — the two tape interfaces share a designer.
 * MAME's ace_tap.cpp waveform (27/27, 8/11, 10/11 and 21/22 samples at
 * 44.1kHz) is the same geometry.
 *
 * The parsed identity is stamped onto the deck's blocks as `TapeFileInfo` so
 * the generic tape pane can show/combine the pairs (LOAD "name" / BLOAD
 * "name") without knowing the Ace.
 */

import type { DataBlock, TapeBlock, TapeFileInfo } from '@/media/tape/tap.ts';

/** Chunk length that identifies a header block (25 payload bytes + checksum). */
export const ACE_TAPE_HEADER_CHUNK = 0x001A;

/** Byte length of an Ace header chunk (payload + checksum). */
export const ACE_TAPE_HEADER_SIZE = ACE_TAPE_HEADER_CHUNK;

/** Convert Ace T-states into the deck's 3.5 MHz-referenced pulse units. */
const ref = (aceT: number): number => Math.round(aceT * (3_500_000 / 3_250_000));

const ACE_PILOT_PULSE = ref(2011);   // 2166 → 2011T played
const ACE_SYNC_1 = ref(601);         // 647 → 601T
const ACE_SYNC_2 = ref(791);         // 852 → 791T
const ACE_BIT_0 = ref(801);          // 863 → 802T
const ACE_BIT_1 = ref(1591);         // 1713 → 1591T
/** Pilot edges the SAVE routine emits: 0x2000 per header, 0x400 per data
 *  block (the INC L / INC H loop at 0x183F, one OUT per iteration). */
const ACE_PILOT_HEADER = 8192;
const ACE_PILOT_DATA = 1024;
/** Inter-block silence (the ROM leaves ~2s before / 3s after each block). */
const ACE_TAPE_PAUSE_MS = 2000;

export interface AceTapeFile {
  /** Filename, trailing spaces trimmed. */
  readonly name: string;
  /** True for dictionary files (type byte 0); false for bytes files. */
  readonly isDictionary: boolean;
  /** Declared file length (LE u16). */
  readonly length: number;
  /** Start address (LE u16); 15441 for dictionary files. */
  readonly start: number;
}

/** Parse an Ace header chunk (25 documented bytes + checksum), or null when
 *  the block isn't one. */
export function parseAceTapeHeader(data: Uint8Array): AceTapeFile | null {
  if (data.length !== ACE_TAPE_HEADER_SIZE && data.length !== ACE_TAPE_HEADER_SIZE - 1) return null;
  let name = '';
  for (let i = 1; i <= 10; i++) name += String.fromCharCode(data[i]);
  return {
    name: name.replace(/ +$/, ''),
    isDictionary: data[0] === 0,
    length: data[11] | (data[12] << 8),
    start: data[13] | (data[14] << 8),
  };
}

/**
 * Parse an Ace .tap: [len16][chunk bytes] chunks with no flag and no
 * checksum of their own — the block type comes from the chunk length and the
 * flag is synthesized, so each DataBlock's rawBytes (what the deck plays
 * bit-exactly) is [flag] + chunk. Timing constants are the Ace's own, not
 * the Spectrum's.
 */
export function parseAceTap(fileData: Uint8Array): TapeBlock[] {
  const blocks: TapeBlock[] = [];
  let offset = 0;
  /** The chunk right after a header is that file's data, whatever its size. */
  let expectData: boolean = false;
  while (offset + 2 <= fileData.length) {
    const chunkLen = fileData[offset] | (fileData[offset + 1] << 8);
    offset += 2;
    if (chunkLen < 2 || offset + chunkLen > fileData.length) break;
    const chunk = fileData.slice(offset, offset + chunkLen);
    offset += chunkLen;

    const isHeader: boolean = !expectData && chunkLen === ACE_TAPE_HEADER_CHUNK;
    expectData = isHeader;
    const flag = isHeader ? 0x00 : 0xFF;
    const rawBytes = new Uint8Array(chunkLen + 1);
    rawBytes[0] = flag;
    rawBytes.set(chunk, 1);

    blocks.push({
      kind: 'data',
      flag,
      data: chunk,
      rawBytes,
      pause: ACE_TAPE_PAUSE_MS,
      pilotPulse: ACE_PILOT_PULSE,
      syncPulse1: ACE_SYNC_1,
      syncPulse2: ACE_SYNC_2,
      bit0Pulse: ACE_BIT_0,
      bit1Pulse: ACE_BIT_1,
      pilotCount: isHeader ? ACE_PILOT_HEADER : ACE_PILOT_DATA,
      usedBits: 8,
      source: 'tap',
    });
  }
  return blocks;
}

/** Stamp Ace file identity onto a parsed block list: each header chunk
 *  block leads a pair whose data child hides behind it in the pane's
 *  combine view. Unrecognised blocks are left untouched. */
export function tagAceTapeFiles(blocks: TapeBlock[]): void {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== 'data' || b.flag !== 0x00) continue;
    const header = parseAceTapeHeader(b.data);
    if (!header) continue;
    const command = header.isDictionary ? 'LOAD' : 'BLOAD';
    const typeName = header.isDictionary ? 'Dictionary' : 'Bytes';
    const lead: TapeFileInfo = {
      name: header.name,
      type: typeName,
      typeName,
      command,
      size: header.length,
      header: true,
    };
    (b as DataBlock).file = lead;
    const next = blocks[i + 1];
    if (next && next.kind === 'data' && next.flag === 0xFF) {
      (next as DataBlock).file = { ...lead, header: false, size: next.data.length };
    }
  }
}
