/**
 * CSW (Compressed Square Wave) tape image parser.
 *
 * CSW is a faithful capture of the cassette waveform as a run-length list of
 * pulse durations: each entry is how long the signal holds its current level
 * (in samples) before flipping to the opposite level. Unlike TAP/TZX there are
 * no discrete data blocks, pilot/sync structure, or checksums — just the raw
 * edge stream — so it can only be replayed at the pulse level (no ROM-trap
 * instant load), exactly like a TZX Direct Recording or Pulse Sequence block.
 *
 * Two revisions exist:
 *   - v1: 16-bit sample rate, always RLE (uncompressed).
 *   - v2: 32-bit sample rate + pulse count, RLE or Z-RLE (the RLE stream is
 *         zlib-compressed). Z-RLE is by far the most common form in the wild.
 *
 * The pulse stream is emitted as a single `csw` TapeBlock whose durations have
 * been converted from samples to 3.5MHz-referenced T-states — the same unit
 * every other block uses — so `TapeDeck.pulseScale` handles the CPC's 4MHz
 * clock transparently. A leading `set-level` block seeds the initial polarity.
 *
 * Parsing is async because Z-RLE inflate goes through the browser
 * DecompressionStream (the codebase's standard, dependency-free inflate).
 */

import type { TapeBlock } from '@/tape/tap.ts';
import { TAPE_REF_HZ } from '@/tape/tap.ts';

// "Compressed Square Wave\x1A" — 22 ASCII chars + 0x1A terminator (23 bytes).
const CSW_MAGIC = 'Compressed Square Wave\x1A';

function read16(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

function read32(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

/** Inflate zlib (deflate) data using the browser DecompressionStream — the same
 *  dependency-free path SZX/ZIP use. Z-RLE wraps the RLE stream in zlib. */
async function inflate(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(compressed as unknown as BufferSource);
  writer.close();

  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.byteLength;
  }

  if (chunks.length === 1) return chunks[0];
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Walk the RLE pulse stream, invoking `emit(samples)` for each pulse.
 *
 * Encoding: a non-zero byte is the pulse length in samples; a zero byte is an
 * escape whose length is the following 32-bit little-endian value (used for
 * pulses ≥ 256 samples). A trailing zero byte with no room for the dword is a
 * truncated file — stop rather than read past the end.
 */
function walkRLE(rle: Uint8Array, emit: (samples: number) => void): void {
  let i = 0;
  while (i < rle.length) {
    const b = rle[i++];
    if (b !== 0) {
      emit(b);
    } else {
      if (i + 4 > rle.length) break;   // truncated escape — stop cleanly
      emit(read32(rle, i));
      i += 4;
    }
  }
}

/** Parse a CSW v1/v2 file into tape blocks: a `set-level` seeding the initial
 *  polarity, followed by a single `csw` pulse block. Throws on a bad signature,
 *  unknown version, unknown compression, or a zero sample rate. */
export async function parseCSW(data: Uint8Array): Promise<TapeBlock[]> {
  for (let i = 0; i < CSW_MAGIC.length; i++) {
    if (data[i] !== CSW_MAGIC.charCodeAt(i)) throw new Error('Not a valid CSW file');
  }

  const major = data[0x17];

  let sampleRate: number;
  let compression: number;
  let flags: number;
  let dataStart: number;

  if (major === 1) {
    sampleRate = read16(data, 0x19);
    compression = data[0x1B];
    flags = data[0x1C];
    dataStart = 0x20;
  } else if (major === 2) {
    sampleRate = read32(data, 0x19);
    // 0x1D..0x20 = total pulse count (informational; we count as we decode).
    compression = data[0x21];
    flags = data[0x22];
    const hdrExtLen = data[0x23];
    // 0x24..0x33 = 16-byte encoder application string (ignored).
    dataStart = 0x34 + hdrExtLen;
  } else {
    throw new Error(`Unsupported CSW version ${major}`);
  }

  if (sampleRate === 0) throw new Error('CSW has a zero sample rate');

  // 1 = RLE (raw), 2 = Z-RLE (zlib-compressed RLE, v2 only).
  let rle: Uint8Array;
  if (compression === 1) {
    rle = data.subarray(dataStart);
  } else if (compression === 2 && major === 2) {
    rle = await inflate(data.subarray(dataStart));
  } else {
    throw new Error(`Unsupported CSW compression type ${compression}`);
  }

  // Convert a sample count to 3.5MHz-referenced T-states. A pulse of `n`
  // samples lasts n/sampleRate seconds; at the 3.5MHz reference that is
  // n * TAPE_REF_HZ / sampleRate T-states. Clamp to ≥1 so a pulse never
  // rounds to a zero-length one (which would spin the playback loop), and
  // to a 31-bit ceiling so an enormous end-of-tape gap can't overflow the
  // Uint32Array store.
  const perSample = TAPE_REF_HZ / sampleRate;
  const toTStates = (samples: number): number => {
    const t = Math.round(samples * perSample);
    return t < 1 ? 1 : t > 0x7FFFFFFF ? 0x7FFFFFFF : t;
  };

  // Two passes: count pulses to size the array exactly, then fill it. Avoids a
  // growable number[] for tapes that decode to millions of pulses.
  let count = 0;
  walkRLE(rle, () => { count++; });

  const pulses = new Uint32Array(count);
  let idx = 0;
  walkRLE(rle, (samples) => { pulses[idx++] = toTStates(samples); });

  const initialPolarity = flags & 1;
  return [
    { kind: 'set-level', level: initialPolarity },
    { kind: 'csw', pulses },
  ];
}
