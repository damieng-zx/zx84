/**
 * The ZX80/ZX81 cassette signal: encoding programs into pulses for the deck,
 * and decoding pulses (a TZX, a WAVE recording, or what the machine itself
 * wrote to its MIC line) back into program images.
 *
 * The documented encoding (the ZX81 manual's cassette chapter, and the TZX
 * specification's ZX81 notes for block 0x19) is the same on both machines:
 *
 *   - every bit is a burst of pulses, each about 150µs high and 150µs low:
 *     4 pulses for a 0, 9 for a 1, followed by about 1300µs of silence;
 *   - bytes go most significant bit first;
 *   - there is no leader tone or checksum. A ZX81 file is the program's name
 *     (ZX81 character codes, the last one with bit 7 set) followed by RAM from
 *     VERSN ($4009) up to, not including, E_LINE; a ZX80 file has no name and
 *     is RAM from $4000 up to E_LINE. LOAD stops when it reaches the E_LINE it
 *     has just read, so the image carries its own length.
 *
 * Pulse lengths are in the deck's 3.5MHz-referenced T-states (TAPE_REF_HZ).
 * The values below are the TZX specification's ZX81 symbols: 530/520T is a
 * 151µs/149µs pulse and 4689T the 1340µs gap that ends a bit.
 *
 * The decoder works on edges only — it counts the short runs between long
 * ones — so it reads a signal of either polarity: the ROM's SAVE leaves the
 * MIC line low in the gaps, but a recording can come back inverted.
 */

import type { CswBlock, TapeBlock } from '@/media/tape/tap.ts';
import { TAPE_REF_HZ } from '@/media/tape/tap.ts';
import { zx81NameToAscii } from './tape-shelf.ts';

export const ZX8X_PULSE_HIGH = 530;
export const ZX8X_PULSE_LOW = 520;
export const ZX8X_BIT_GAP = 4689;
/** Silence ahead of a program generated from an image (the ROM's own SAVE
 *  waits five seconds; half a second is plenty for LOAD to be listening). */
const LEAD_SILENCE = TAPE_REF_HZ / 2;
/** Silence after a generated program, as a Pause block (ms). */
const TRAIL_PAUSE_MS = 1000;

/** A run up to 600µs belongs to a pulse; anything longer is a gap. */
const SHORT_MAX = Math.round(TAPE_REF_HZ * 600e-6);
/** A gap over 5ms ends a file (bits are ~1.3ms apart, bytes barely more). */
const FILE_GAP = Math.round(TAPE_REF_HZ * 5e-3);
/** Pulses per burst read as a 0 / a 1 (nominally 4 and 9). */
const ZERO_MIN = 3;
const ONE_MIN = 7;
const ONE_MAX = 12;

const ZX81_BASE = 0x4009;
const ZX80_BASE = 0x4000;
const ZX81_E_LINE = 0x4014;
const ZX80_E_LINE = 0x400a;

export type Zx8xTapeModel = 'zx80' | 'zx81';

/** A program as it travels on tape. */
export interface Zx8xTapeProgram {
  /** Upper-case ASCII name ('' on the ZX80). */
  readonly name: string;
  /** The RAM image: VERSN.. (ZX81) or $4000.. (ZX80) up to E_LINE. */
  readonly data: Uint8Array;
}

/** A program located on a deck: the blocks its pulses start and end in. */
export interface Zx8xDeckProgram extends Zx8xTapeProgram {
  readonly startBlock: number;
  readonly endBlock: number;
}

/** ZX81 character codes 0x00-0x3F, as tape-shelf.ts decodes them. */
const ZX81_CHARSET = ' ??????????"£$:?()><=+-*/;,.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Encode an ASCII name as a ZX81 tape name (last code with bit 7 set).
 *  Characters the ZX81 cannot show become '?'; an empty name is "PROGRAM". */
export function asciiToZx81Name(name: string): Uint8Array {
  const text = name.toUpperCase().trim() || 'PROGRAM';
  const codes = new Uint8Array(Math.min(text.length, 127));
  for (let i = 0; i < codes.length; i++) {
    // indexOf would find '?' among the graphics; 0x0F is the ZX81's '?'.
    const at = text[i] === '?' ? 0x0f : ZX81_CHARSET.indexOf(text[i]);
    codes[i] = at < 0 ? 0x0f : at;
  }
  codes[codes.length - 1] |= 0x80;
  return codes;
}

/** The pulse runs for `bytes`, starting with `lead` T of silence (low) and
 *  ending on the last pulse's high half. */
export function encodeZx8xBytes(bytes: Uint8Array, lead = LEAD_SILENCE): Uint32Array {
  let count = 1;
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 7; b >= 0; b--) count += ((bytes[i] >> b) & 1 ? 9 : 4) * 2;
  }
  const out = new Uint32Array(count - 1);
  let n = 0;
  out[n++] = lead;
  let first = true;
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 7; b >= 0; b--) {
      if (!first) out[n++] = ZX8X_BIT_GAP;
      first = false;
      const pulses = (bytes[i] >> b) & 1 ? 9 : 4;
      for (let p = 0; p < pulses; p++) {
        if (p > 0) out[n++] = ZX8X_PULSE_LOW;
        out[n++] = ZX8X_PULSE_HIGH;
      }
    }
  }
  return out.subarray(0, n);
}

/** Where zx8xProgramBlocks puts the program's pulses. */
export const ZX8X_PROGRAM_BLOCK = 1;

/**
 * Deck blocks for one program image: the level pinned low, one labelled
 * pulse block (silence, then the name and image), and a trailing pause.
 * `nameCodes` is the ZX81 tape name (null on the ZX80).
 */
export function zx8xProgramBlocks(model: Zx8xTapeModel, nameCodes: Uint8Array | null, data: Uint8Array): TapeBlock[] {
  const bytes = new Uint8Array((nameCodes?.length ?? 0) + data.length);
  if (nameCodes) bytes.set(nameCodes);
  bytes.set(data, nameCodes?.length ?? 0);
  const name = nameCodes ? zx81NameToAscii(nameCodes).trim() : '';
  const program: CswBlock = {
    kind: 'csw',
    pulses: encodeZx8xBytes(bytes),
    ...programLabel(model, name, data.length),
  };
  return [{ kind: 'set-level', level: 0 }, program, { kind: 'pause', duration: TRAIL_PAUSE_MS }];
}

function programLabel(model: Zx8xTapeModel, name: string, size: number): Pick<CswBlock, 'role' | 'label' | 'detail'> {
  return {
    role: 'data',
    label: model === 'zx81' ? `LOAD "${name}"` : 'LOAD',
    detail: `Program · ${size} bytes`,
  };
}

/** Streaming edge decoder: feed it run lengths, collect the files. */
class Zx8xEdgeDecoder {
  readonly files: { bytes: Uint8Array; startBlock: number; endBlock: number }[] = [];
  private shorts = 0;
  private burstBlock = 0;
  private lastBlock = 0;
  private bytes: number[] = [];
  private acc = 0;
  private bits = 0;
  private fileStart = -1;

  feed(run: number, block: number): void {
    if (run <= SHORT_MAX) {
      if (this.shorts === 0) this.burstBlock = block;
      this.shorts++;
      this.lastBlock = block;
      return;
    }
    if (this.shorts > 0) this.endBurst();
    if (run > FILE_GAP) this.endFile();
  }

  /** A boundary that is not a pulse at all (a Spectrum data block, say). */
  boundary(): void {
    if (this.shorts > 0) this.endBurst();
    this.endFile();
  }

  finish(): void { this.boundary(); }

  private endBurst(): void {
    // k pulses bounded by gaps are 2k-1 runs, whichever level is "high".
    const pulses = (this.shorts + 1) >> 1;
    this.shorts = 0;
    let bit: number;
    if (pulses >= ONE_MIN && pulses <= ONE_MAX) bit = 1;
    else if (pulses >= ZERO_MIN && pulses < ONE_MIN) bit = 0;
    else { this.endFile(); return; }
    if (this.fileStart < 0) this.fileStart = this.burstBlock;
    this.acc = (this.acc << 1) | bit;
    if (++this.bits === 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.bits = 0;
    }
  }

  private endFile(): void {
    if (this.bytes.length > 0) {
      this.files.push({ bytes: Uint8Array.from(this.bytes), startBlock: this.fileStart, endBlock: this.lastBlock });
    }
    this.bytes = [];
    this.acc = 0;
    this.bits = 0;
    this.fileStart = -1;
  }
}

/** Split the bytes of one file into name and RAM image, or null when they
 *  are not a complete program (cut short, or too short to hold E_LINE). */
export function parseZx8xTapeFile(model: Zx8xTapeModel, bytes: Uint8Array): Zx8xTapeProgram | null {
  let name = '';
  let data = bytes;
  if (model === 'zx81') {
    const limit = Math.min(bytes.length, 128);
    let end = -1;
    for (let i = 0; i < limit; i++) if (bytes[i] & 0x80) { end = i; break; }
    if (end < 0) return null;
    name = zx81NameToAscii(bytes.subarray(0, end + 1)).trim();
    data = bytes.subarray(end + 1);
  }
  const base = model === 'zx81' ? ZX81_BASE : ZX80_BASE;
  const at = (model === 'zx81' ? ZX81_E_LINE : ZX80_E_LINE) - base;
  if (data.length < at + 2) return null;
  const length = (data[at] | (data[at + 1] << 8)) - base;
  if (length < at + 2 || length > data.length) return null;
  return { name, data: data.slice(0, length) };
}

/** Decode a run-length stream (one pulse per entry) into the programs on it.
 *  `scale` converts the runs to 3.5MHz-referenced T-states. */
export function decodeZx8xPulses(model: Zx8xTapeModel, runs: ArrayLike<number>, scale = 1): Zx8xTapeProgram[] {
  const decoder = new Zx8xEdgeDecoder();
  for (let i = 0; i < runs.length; i++) decoder.feed(runs[i] * scale, 0);
  decoder.finish();
  const out: Zx8xTapeProgram[] = [];
  for (const file of decoder.files) {
    const program = parseZx8xTapeFile(model, file.bytes);
    if (program) out.push(program);
  }
  return out;
}

/** Find the programs a deck's blocks carry, by decoding their pulses. */
export function findZx8xPrograms(model: Zx8xTapeModel, blocks: readonly TapeBlock[]): Zx8xDeckProgram[] {
  const decoder = new Zx8xEdgeDecoder();
  blocks.forEach((block, index) => {
    switch (block.kind) {
      case 'pulses':
        for (const run of block.lengths) decoder.feed(run, index);
        break;
      case 'csw':
        for (let i = 0; i < block.pulses.length; i++) decoder.feed(block.pulses[i], index);
        break;
      case 'pause':
        decoder.feed(block.duration === 0 ? Infinity : block.duration * (TAPE_REF_HZ / 1000), index);
        break;
      case 'direct': {
        // Sampled levels: each run of equal samples is one pulse.
        let level = -1;
        let run = 0;
        const total = (block.data.length - 1) * 8 + Math.max(1, block.usedBits);
        for (let s = 0; s < total; s++) {
          const bit = (block.data[s >> 3] >> (7 - (s & 7))) & 1;
          if (bit !== level && level >= 0) { decoder.feed(run, index); run = 0; }
          level = bit;
          run += block.tStatesPerSample;
        }
        if (run > 0) decoder.feed(run, index);
        if (block.pause > 0) decoder.feed(block.pause * (TAPE_REF_HZ / 1000), index);
        break;
      }
      case 'data':
      case 'tone':
        decoder.boundary();
        break;
      default:
        break;   // set-level, text, groups: no time passes
    }
  });
  decoder.finish();
  const out: Zx8xDeckProgram[] = [];
  for (const file of decoder.files) {
    const program = parseZx8xTapeFile(model, file.bytes);
    if (program) out.push({ ...program, startBlock: file.startBlock, endBlock: file.endBlock });
  }
  return out;
}

/** Give each pulse block that holds exactly one program its LOAD line in the
 *  tape pane (a TZX 0x19 block expands to plain pulses with no label). */
export function labelZx8xPrograms(model: Zx8xTapeModel, blocks: TapeBlock[], programs: readonly Zx8xDeckProgram[]): void {
  const perBlock = new Map<number, number>();
  for (const p of programs) perBlock.set(p.startBlock, (perBlock.get(p.startBlock) ?? 0) + 1);
  for (const p of programs) {
    if (p.startBlock !== p.endBlock || perBlock.get(p.startBlock) !== 1) continue;
    const block = blocks[p.startBlock];
    if (block.kind === 'pulses') {
      blocks[p.startBlock] = { kind: 'csw', pulses: Uint32Array.from(block.lengths), ...programLabel(model, p.name, p.data.length) };
    } else if (block.kind === 'csw' && !block.label) {
      blocks[p.startBlock] = { ...block, ...programLabel(model, p.name, p.data.length) };
    }
  }
}

/**
 * A WAVE recording's polarity is whatever the recording chain made it, but
 * the ROM's LOAD wants the signal high only inside a pulse: it times the
 * silence after a burst as samples with bit 7 low. When most of a recording's
 * long runs (the gaps between bursts) sit high, flip the block's starting
 * level so they read low.
 */
export function normaliseZx8xPolarity(blocks: TapeBlock[]): void {
  for (let i = 0; i + 1 < blocks.length; i++) {
    const set = blocks[i];
    const csw = blocks[i + 1];
    if (set.kind !== 'set-level' || csw.kind !== 'csw') continue;
    let level = set.level;
    let high = 0;
    let low = 0;
    for (let p = 0; p < csw.pulses.length; p++) {
      if (csw.pulses[p] > SHORT_MAX) {
        if (level) high++; else low++;
      }
      level ^= 1;
    }
    if (high > low) blocks[i] = { kind: 'set-level', level: set.level ^ 1 };
  }
}
