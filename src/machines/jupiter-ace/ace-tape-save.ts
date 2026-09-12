/**
 * Jupiter Ace tape saving — capture of the MIC line, and the decoder that
 * turns what it captured back into an Ace .tap.
 *
 * Nothing traps or patches the ROM: SAVE runs its own routine at 0x1820 and
 * shapes the cassette waveform by writing bit 3 of the ULA port, exactly as it
 * would drive a real recorder. The recorder below just times the transitions,
 * and the decoder reads them back with the same geometry the ROM writes:
 *
 *   pilot  2011T half-cycles (8192 per header block, 1024 per data block)
 *   sync   601T then 791T
 *   bit 0  two 801T half-cycles    bit 1  two 1591T half-cycles
 *
 * (See ace-tape.ts for where those figures come from — they are the
 * instruction timings of the SAVE routine itself.)
 *
 * The decoder only accepts a block that arrives behind a proper leader. That
 * matters because MIC is not the only thing that moves the port: the FORTH
 * BEEP word writes A = D, its own countdown's high byte, so bit 3 flickers
 * whenever the machine beeps. Those edges are the wrong widths and carry no
 * leader, so they are skipped rather than decoded into nonsense.
 */

/** Ace T-states, as written by the SAVE routine (0x1820-0x189A). */
const PILOT_T = 2011;
const BIT0_T = 801;
const BIT1_T = 1591;

/** Half-way marks between the widths above, used to classify an edge. */
const BIT_THRESHOLD = Math.round((BIT0_T + BIT1_T) / 2);      // 1196
const PILOT_THRESHOLD = Math.round((BIT1_T + PILOT_T) / 2);   // 1801
/** Anything longer than this is silence between blocks, not a pulse. */
const GAP_T = 4000;
/** A leader must run at least this many edges to count as one. The ROM writes
 *  1024 even for a data block, so this is far below anything genuine while
 *  still rejecting stray beeps. */
const MIN_LEADER_EDGES = 64;

/** Cap on retained edges (~5x a full 48K save) so a machine left running with
 *  a flickering MIC line cannot grow this without bound. */
export const ACE_SAVE_MAX_EDGES = 1_000_000;

/**
 * Times MIC transitions. Fed from the port handlers after every ULA access,
 * it records the T-states between successive changes of the line.
 */
export class AceTapeRecorder {
  /** T-states between MIC transitions, oldest first. */
  readonly edges: number[] = [];
  private level = 0;
  private lastT = 0;
  private seenFirstEdge = false;

  /** Observe the MIC line at absolute T-state `t`. Only a change counts: a
   *  read that clears an already-low line is not an edge. */
  observe(level: number, t: number): void {
    if (level === this.level) return;
    this.level = level;
    if (!this.seenFirstEdge) {
      // Start timing from the first transition; what came before is silence.
      this.seenFirstEdge = true;
      this.lastT = t;
      return;
    }
    if (this.edges.length < ACE_SAVE_MAX_EDGES) this.edges.push(t - this.lastT);
    this.lastT = t;
  }

  get hasRecording(): boolean { return this.edges.length >= MIN_LEADER_EDGES; }

  reset(): void {
    this.edges.length = 0;
    this.level = 0;
    this.lastT = 0;
    this.seenFirstEdge = false;
  }
}

/** One decoded block: the flag byte the ROM sent, then the chunk it framed. */
interface DecodedBlock {
  flag: number;
  /** Payload plus the ROM's checksum byte — an Ace .tap chunk verbatim. */
  chunk: number[];
}

/** Read the blocks out of a captured edge stream. */
export function decodeAceSaveBlocks(edges: readonly number[]): DecodedBlock[] {
  const blocks: DecodedBlock[] = [];
  let i = 0;
  while (i < edges.length) {
    // A leader: a run of pilot-width edges. Anything else is skipped, which
    // is how beeps and other port traffic fall out of the stream.
    let leader = 0;
    while (i < edges.length && edges[i] >= PILOT_THRESHOLD && edges[i] <= GAP_T) { leader++; i++; }
    if (leader < MIN_LEADER_EDGES) { i++; continue; }
    // Sync: the 601T/791T pair the ROM writes once the leader ends.
    if (i + 1 >= edges.length) break;
    i += 2;

    const bytes: number[] = [];
    let bits = 0;
    let bitCount = 0;
    // Each bit is a full cycle: two equal half-cycles, MSB first.
    while (i + 1 < edges.length) {
      const width = edges[i];
      if (width >= PILOT_THRESHOLD || width > GAP_T) break;   // next leader, or silence
      bits = ((bits << 1) | (width >= BIT_THRESHOLD ? 1 : 0)) & 0xFF;
      if (++bitCount === 8) {
        bytes.push(bits);
        bits = 0;
        bitCount = 0;
      }
      i += 2;
    }
    // flag + at least one framed byte, else it was not a block at all.
    if (bytes.length >= 2) blocks.push({ flag: bytes[0], chunk: bytes.slice(1) });
  }
  return blocks;
}

/**
 * Decode a capture into Ace .tap bytes: each block becomes a [len16][chunk]
 * record, the flag dropped because the container does not store it (see
 * ace-tape.ts). Returns null when the capture holds no complete block.
 */
export function decodeAceSaveToTap(edges: readonly number[]): Uint8Array | null {
  const blocks = decodeAceSaveBlocks(edges);
  if (blocks.length === 0) return null;
  const size = blocks.reduce((n, b) => n + 2 + b.chunk.length, 0);
  const out = new Uint8Array(size);
  let p = 0;
  for (const block of blocks) {
    out[p++] = block.chunk.length & 0xFF;
    out[p++] = (block.chunk.length >> 8) & 0xFF;
    out.set(block.chunk, p);
    p += block.chunk.length;
  }
  return out;
}
