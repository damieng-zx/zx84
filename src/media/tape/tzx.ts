/**
 * TZX tape image format parser.
 *
 * Parses TZX files into a TapeBlock[] array using the discriminated union
 * type system. All meaningful block types are extracted: data blocks (0x10,
 * 0x11, 0x14), pure tone (0x12), pulse sequence (0x13), direct recording
 * (0x15), pause/stop (0x20), groups (0x21/22), loops (0x24/25), stop-if-48k
 * (0x2A), set signal level (0x2B), text (0x30), and archive info (0x32).
 * Loops are expanded at parse time.
 */

import type { TapeBlock, DataBlock } from '@/media/tape/tap.ts';

const TZX_MAGIC = [0x5A, 0x58, 0x54, 0x61, 0x70, 0x65, 0x21, 0x1A]; // "ZXTape!\x1A"

/** Hard ceiling on expanded output blocks. Nested Loop Start/End pairs
 *  multiply (each up to 65535 repetitions), so unbounded expansion turns a
 *  tiny hand-crafted TZX into billions of pushed entries — an OOM/hang.
 *  Real tapes stay orders of magnitude below this. */
const MAX_EXPANDED_BLOCKS = 262144;

function read16(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

function read24(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16);
}

function read32(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

function readString(d: Uint8Array, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(d[o + i]);
  return s;
}

function readSigned16(d: Uint8Array, o: number): number {
  const value = read16(d, o);
  return value & 0x8000 ? value - 0x10000 : value;
}

/** Return the offset of the block after the one starting at `start`. */
function nextBlockOffset(d: Uint8Array, start: number): number {
  const id = d[start];
  const p = start + 1;
  switch (id) {
    case 0x10: return p + 4 + read16(d, p + 2);
    case 0x11: return p + 18 + read24(d, p + 15);
    case 0x12: return p + 4;
    case 0x13: return p + 1 + d[p] * 2;
    case 0x14: return p + 10 + read24(d, p + 7);
    case 0x15: return p + 8 + read24(d, p + 5);
    case 0x18:
    case 0x19:
    case 0x2B: return p + 4 + read32(d, p);
    case 0x20: return p + 2;
    case 0x21: return p + 1 + d[p];
    case 0x22:
    case 0x25:
    case 0x27: return p;
    case 0x23:
    case 0x24: return p + 2;
    case 0x26: return p + 2 + read16(d, p) * 2;
    case 0x28: return p + 2 + read16(d, p);
    case 0x2A: return p + 4;
    case 0x30: return p + 1 + d[p];
    case 0x31: return p + 2 + d[p + 1];
    case 0x32: return p + 2 + read16(d, p);
    case 0x33: return p + 1 + d[p] * 3;
    case 0x35: return p + 20 + read32(d, p + 16);
    case 0x5A: return p + 9;
    default: throw new Error(`Unknown TZX block type 0x${id.toString(16).padStart(2, '0')} at offset ${start}`);
  }
}

function blockOffsets(d: Uint8Array): number[] {
  const starts: number[] = [];
  for (let o = 10; o < d.length;) {
    starts.push(o);
    const next = nextBlockOffset(d, o);
    if (next <= o || next > d.length) throw new Error(`Truncated TZX block at offset ${o}`);
    o = next;
  }
  return starts;
}

/** Extract a DataBlock from raw block data with baked-in timing. */
function extractDataBlock(
  raw: Uint8Array,
  pause: number,
  pilotPulse: number,
  syncPulse1: number,
  syncPulse2: number,
  bit0Pulse: number,
  bit1Pulse: number,
  pilotCount: number,
  usedBits: number,
  source: DataBlock['source'],
): DataBlock | null {
  if (raw.length < 2) return null;
  return {
    kind: 'data',
    flag: raw[0],
    data: raw.slice(1, raw.length - 1),
    pause,
    pilotPulse,
    syncPulse1,
    syncPulse2,
    bit0Pulse,
    bit1Pulse,
    pilotCount,
    usedBits,
    source,
  };
}

export function parseTZX(fileData: Uint8Array): TapeBlock[] {
  // Verify magic header
  for (let i = 0; i < TZX_MAGIC.length; i++) {
    if (fileData[i] !== TZX_MAGIC[i]) {
      throw new Error('Not a valid TZX file');
    }
  }

  const blocks: TapeBlock[] = [];
  const starts = blockOffsets(fileData);
  const startIndex = new Map(starts.map((start, index) => [start, index]));
  let o = 10; // skip 8-byte magic + major + minor version

  // Loop expansion state. A stack is needed because TZX permits nested
  // loops; a single pair would let an inner Loop End clobber the outer
  // bookkeeping, silently dropping the outer expansion.
  const loopStack: { start: number; count: number }[] = [];
  const callStack: number[] = [];

  // Jump/Call/Select/Return reposition the cursor, and since loops are
  // expanded at parse time a cycle in that control flow can never terminate
  // (a Jump with offset -1 targets itself). Budget iterations generously
  // against the pre-computed block table — legitimate files execute each
  // block once plus a little call/return revisit traffic — and reject the
  // tape as cyclic if the budget is exhausted.
  const maxSteps = starts.length * 4 + 1024;
  let steps = 0;

  while (o < fileData.length) {
    if (++steps > maxSteps) {
      throw new Error('TZX control flow does not terminate (cyclic Jump/Call/Select block)');
    }
    // Remember where this block starts so the shared offset arithmetic can
    // advance past it; flow-control blocks position `o` themselves and skip
    // the shared advance with `continue`.
    const blockStart = o;
    const id = fileData[o++];

    switch (id) {
      case 0x10: { // Standard Speed Data Block
        const pause = read16(fileData, o);
        const len = read16(fileData, o + 2);
        const raw = fileData.slice(o + 4, o + 4 + len);
        // Pilot length follows the high bit of the flag: < 0x80 → long
        // header pilot (8063), >= 0x80 → short data pilot (3223). Matches
        // the ZX Spectrum ROM SAVE-BYTES behaviour.
        const pilotCount = raw.length > 0 && raw[0] < 0x80 ? 8063 : 3223;
        const blk = extractDataBlock(raw, pause, 2168, 667, 735, 855, 1710, pilotCount, 8, 'standard');
        if (blk) { blk.rawBytes = raw; blocks.push(blk); }
        break;
      }
      case 0x11: { // Turbo Speed Data Block
        const pilotPulse = read16(fileData, o);
        const syncPulse1 = read16(fileData, o + 2);
        const syncPulse2 = read16(fileData, o + 4);
        const bit0Pulse = read16(fileData, o + 6);
        const bit1Pulse = read16(fileData, o + 8);
        const pilotCount = read16(fileData, o + 10);
        const usedBits = fileData[o + 12];
        const pause = read16(fileData, o + 13);
        const len = read24(fileData, o + 15);
        const raw = fileData.slice(o + 18, o + 18 + len);
        const blk = extractDataBlock(raw, pause, pilotPulse, syncPulse1, syncPulse2, bit0Pulse, bit1Pulse, pilotCount, usedBits, 'turbo');
        if (blk) { blk.rawBytes = raw; blocks.push(blk); }
        break;
      }
      case 0x12: { // Pure Tone
        const pulseLen = read16(fileData, o);
        const count = read16(fileData, o + 2);
        blocks.push({ kind: 'tone', pulseLen, count });
        break;
      }
      case 0x13: { // Pulse Sequence
        const count = fileData[o];
        const lengths: number[] = [];
        for (let i = 0; i < count; i++) {
          lengths.push(read16(fileData, o + 1 + i * 2));
        }
        blocks.push({ kind: 'pulses', lengths });
        break;
      }
      case 0x14: { // Pure Data Block
        // Pure data is NOT in TAP format — no flag byte or checksum.
        // Store raw bytes directly; the playback engine uses them as-is.
        const bit0Pulse = read16(fileData, o);
        const bit1Pulse = read16(fileData, o + 2);
        const usedBits = fileData[o + 4];
        const pause = read16(fileData, o + 5);
        const len = read24(fileData, o + 7);
        const data = fileData.slice(o + 10, o + 10 + len);
        if (data.length > 0) {
          blocks.push({
            kind: 'data',
            flag: 0xFF,
            data,
            pause,
            pilotPulse: 0,
            syncPulse1: 0,
            syncPulse2: 0,
            bit0Pulse,
            bit1Pulse,
            pilotCount: 0,
            usedBits,
            source: 'pure-data',
          });
        }
        break;
      }
      case 0x15: { // Direct Recording
        const tStatesPerSample = read16(fileData, o);
        const pause = read16(fileData, o + 2);
        const usedBits = fileData[o + 4];
        const len = read24(fileData, o + 5);
        const data = fileData.slice(o + 8, o + 8 + len);
        blocks.push({ kind: 'direct', tStatesPerSample, pause, usedBits, data });
        break;
      }
      case 0x18: // CSW Recording
      { // pause + sample rate + compression + pulse count + RLE data
        const blockLen = read32(fileData, o);
        const body = o + 4;
        const pause = read16(fileData, body);
        const sampleRate = read32(fileData, body + 2);
        const compression = fileData[body + 6];
        const pulseCount = read32(fileData, body + 7);
        if (compression !== 1) {
          throw new Error(`Unsupported embedded TZX CSW compression type ${compression}`);
        }
        const rleStart = body + 11;
        const rleEnd = body + blockLen;
        // Validate before allocating: a zero sample rate would poison every
        // pulse with NaN/Infinity, and each RLE item produces at most one
        // pulse from at least one byte — so a header claiming more pulses
        // than there are RLE bytes is corrupt. Bounded by the RLE length,
        // the allocation can never blow up on a hostile header value.
        if (sampleRate === 0) throw new Error('Embedded TZX CSW has a zero sample rate');
        if (pulseCount > rleEnd - rleStart) {
          throw new Error('Truncated embedded TZX CSW recording');
        }
        const pulses = new Uint32Array(pulseCount);
        let pulse = 0;
        for (let p = rleStart; p < rleEnd && pulse < pulseCount;) {
          const length = fileData[p++];
          if (length !== 0) {
            pulses[pulse++] = Math.max(1, Math.round(length * 3_500_000 / sampleRate));
          } else {
            if (p + 4 > rleEnd) throw new Error('Truncated embedded TZX CSW pulse');
            const samples = read32(fileData, p);
            p += 4;
            pulses[pulse++] = Math.max(1, Math.round(samples * 3_500_000 / sampleRate));
          }
        }
        if (pulse !== pulseCount) throw new Error('Truncated embedded TZX CSW recording');
        blocks.push({ kind: 'csw', pulses });
        if (pause > 0) blocks.push({ kind: 'pause', duration: pause });
        break;
      }
      case 0x19: // Generalized Data Block (skipped)
        break;
      case 0x20: { // Pause / Stop the tape
        const duration = read16(fileData, o);
        blocks.push({ kind: 'pause', duration });
        break;
      }
      case 0x21: { // Group Start
        const nameLen = fileData[o];
        const name = readString(fileData, o + 1, nameLen);
        blocks.push({ kind: 'group-start', name });
        break;
      }
      case 0x22: // Group End
        blocks.push({ kind: 'group-end' });
        break;
      case 0x23: { // Jump to Block
        const index = startIndex.get(blockStart)!;
        const target = index + 1 + readSigned16(fileData, o);
        if (target < 0 || target >= starts.length) throw new Error('TZX jump target is out of range');
        o = starts[target];
        continue;
      }
      case 0x24: // Loop Start
        loopStack.push({ start: blocks.length, count: read16(fileData, o) });
        break;
      case 0x25: { // Loop End
        const frame = loopStack.pop();
        if (frame && frame.count > 1) {
          const loopBody = blocks.slice(frame.start);
          const extra = loopBody.length * (frame.count - 1);
          if (blocks.length + extra > MAX_EXPANDED_BLOCKS) {
            throw new Error('TZX loop expansion too large (nested loops?)');
          }
          for (let i = 1; i < frame.count; i++) {
            for (const blk of loopBody) blocks.push(blk);
          }
        }
        break;
      }
      case 0x26: { // Call Sequence (select the first destination)
        const index = startIndex.get(blockStart)!;
        const count = read16(fileData, o);
        if (count === 0) break;
        const target = index + 1 + readSigned16(fileData, o + 2);
        if (target < 0 || target >= starts.length) throw new Error('TZX call target is out of range');
        callStack.push(index + 1);
        o = starts[target];
        continue;
      }
      case 0x27: { // Return from Sequence
        const target = callStack.pop();
        if (target === undefined) throw new Error('TZX return without call');
        if (target >= starts.length) { o = fileData.length; continue; }
        o = starts[target];
        continue;
      }
      case 0x28: { // Select Block (choose the first option)
        const index = startIndex.get(blockStart)!;
        const count = fileData[o + 2];
        if (count === 0) break;
        const target = index + 1 + readSigned16(fileData, o + 3);
        if (target < 0 || target >= starts.length) throw new Error('TZX select target is out of range');
        o = starts[target];
        continue;
      }
      case 0x2A: // Stop tape if in 48K mode
        blocks.push({ kind: 'stop-if-48k' });
        break;
      case 0x2B: { // Set Signal Level
        const level = fileData[o + 4] & 1;
        blocks.push({ kind: 'set-level', level });
        break;
      }
      case 0x30: { // Text Description
        const textLen = fileData[o];
        const text = readString(fileData, o + 1, textLen);
        blocks.push({ kind: 'text', text });
        break;
      }
      case 0x31: // Message Block (skipped)
        break;
      case 0x32: { // Archive Info
        const totalLen = read16(fileData, o);
        const numStrings = fileData[o + 2];
        const entries: { id: number; text: string }[] = [];
        let pos = o + 3;
        for (let i = 0; i < numStrings && pos < o + 2 + totalLen; i++) {
          const entryId = fileData[pos];
          const entryLen = fileData[pos + 1];
          const entryText = readString(fileData, pos + 2, entryLen);
          entries.push({ id: entryId, text: entryText });
          pos += 2 + entryLen;
        }
        blocks.push({ kind: 'archive-info', entries });
        break;
      }
      case 0x33: // Hardware Type (skipped)
        break;
      case 0x35: // Custom Info Block (skipped)
        break;
      case 0x5A: // Glue block (skipped)
        break;
      default:
        throw new Error(`Unknown TZX block type 0x${id.toString(16).padStart(2, '0')} at offset ${blockStart}`);
    }

    // Advance past this block with the same offset arithmetic the up-front
    // validation pass used — one source of truth for block sizes.
    o = nextBlockOffset(fileData, blockStart);
  }

  return blocks;
}
