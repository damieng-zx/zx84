/**
 * ZX80/ZX81 TapeService — the cassette deck (zx8x/cassette.ts) and what the
 * machine has SAVEd.
 *
 * The deck plays pulses into the EAR bit of a keyboard-port read; a `.p`/`.o`
 * image is turned into the documented pulse train on mount, and a TZX or a
 * WAVE recording plays as it is (see tape-signal.ts). With "Fast ROM loading"
 * on, the ROM's LOAD is trapped and reads the programs found on the tape
 * directly; otherwise LOAD starts the deck and reads it in real time.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { TAPE_REF_HZ } from '@/media/tape/tap.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { wavToPulseBlocks } from '@/media/tape/wav.ts';
import { tapeBlockInfo } from '@/machines/shared/tape-block-info.ts';
import type { Zx8xMachine } from '../zx8x-machine.ts';
import { ZX8X_CPU_CLOCK } from '../constants.ts';
import { programNameFromFilename } from '../tape-shelf.ts';
import { zx81NameToAscii } from '../tape-shelf.ts';
import {
  asciiToZx81Name, decodeZx8xPulses, normaliseZx8xPolarity, parseZx8xTapeFile, zx8xProgramBlocks,
  ZX8X_PROGRAM_BLOCK, type Zx8xDeckProgram,
} from '../tape-signal.ts';

/** Characters a host filename cannot carry (ZX81 names may contain '"', '/',
 *  '*', '?', ':', '<', '>'). */
const UNSAFE_FILENAME = /[\/:*?"<>|]/g;

/** Split the name a P81 image carries ahead of its payload: the codes up to
 *  and including the first with bit 7 set (at most 128), or null if none. */
export function splitP81(data: Uint8Array): { name: Uint8Array; payload: Uint8Array } | null {
  const limit = Math.min(128, data.length);
  for (let i = 0; i < limit; i++) {
    if (data[i] & 0x80) return { name: data.subarray(0, i + 1), payload: data.subarray(i + 1) };
  }
  return null;
}

/** Program images each model's LOAD takes (.o/.80 on the ZX80, .p/.81/.p81
 *  on the ZX81). */
export function isZx8xProgramFile(model: 'zx80' | 'zx81', filename: string): boolean {
  return model === 'zx80' ? /\.(o|80)$/i.test(filename) : /\.(p|81|p81)$/i.test(filename);
}

/**
 * Deck blocks for a file: a program image becomes its pulse train (a ZX81
 * `.p` named after the file, a `.p81` after the name it carries), a TZX is
 * parsed, a WAVE recording is thresholded into pulses with the gaps low.
 * For an image, `program` is what is on it: the image up to its E_LINE, or
 * the whole image when it does not hold a plausible E_LINE.
 */
export function zx8xTapeBlocks(model: 'zx80' | 'zx81', data: Uint8Array, filename: string): { blocks: TapeBlock[]; program?: Zx8xDeckProgram } {
  if (/\.tzx$/i.test(filename)) return { blocks: parseTZX(data) };
  if (/\.wav$/i.test(filename)) {
    const blocks = wavToPulseBlocks(data);
    normaliseZx8xPolarity(blocks);
    return { blocks };
  }
  let nameCodes: Uint8Array | null = null;
  let payload = data;
  if (model === 'zx81') {
    const split = /\.p81$/i.test(filename) ? splitP81(data) : null;
    nameCodes = split ? split.name : asciiToZx81Name(programNameFromFilename(filename));
    if (split) payload = split.payload;
  }
  const blocks = zx8xProgramBlocks(model, nameCodes, payload);
  const name = nameCodes ? zx81NameToAscii(nameCodes).trim() : '';
  const image = parseZx8xTapeFile(model, nameCodes ? concat(nameCodes, payload) : payload)?.data ?? payload.slice();
  return { blocks, program: { name, data: image, startBlock: ZX8X_PROGRAM_BLOCK, endBlock: ZX8X_PROGRAM_BLOCK } };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export class Zx8xTapeService implements TapeService {
  constructor(private readonly machine: Zx8xMachine) {}

  private get cassette() { return this.machine.cassette; }

  get loaded(): boolean { return this.cassette.loaded; }
  get name(): string { return this.cassette.name; }
  get blocks(): readonly TapeBlockInfo[] { return this.cassette.deck.blocks.map(tapeBlockInfo); }
  get rawBlocks(): readonly TapeBlock[] { return this.cassette.deck.blocks; }
  get position(): number { return this.cassette.deck.position; }
  get playing(): boolean { return this.cassette.deck.playing; }
  get paused(): boolean { return this.cassette.deck.paused; }

  /** The reload-restore path: the tape at its start, stopped. */
  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    if (!/\.(tzx|wav)$/i.test(name) && !isZx8xProgramFile(this.machine.model, name)) return false;
    try {
      const tape = zx8xTapeBlocks(this.machine.model, data, name);
      this.cassette.mount(tape.blocks, name, 0, tape.program ? [tape.program] : undefined);
    } catch {
      return false;
    }
    return true;
  }

  stashState(): TapeStashState | null {
    if (!this.cassette.loaded) return null;
    return { blocks: [...this.cassette.deck.blocks], position: this.cassette.deck.position, paused: true };
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (!state.blocks || state.blocks.length === 0) return;
    this.cassette.mount(state.blocks, name, state.position ?? 0);
  }

  play(): void {
    this.cassette.userHold = false;
    this.machine.playTape();
  }

  pause(): void {
    this.cassette.deck.paused = true;
    this.cassette.userHold = true;
  }

  resume(): void {
    this.cassette.userHold = false;
    this.machine.playTape();
  }

  stop(): void {
    this.cassette.userHold = true;
    this.cassette.deck.stopPlayback();
  }

  rewind(): void {
    this.cassette.deck.rewind();
    this.cassette.syncCursor();
  }

  seek(block: number): void {
    this.cassette.deck.position = block;
    if (this.cassette.deck.playing) this.cassette.deck.startPlayback();
    this.cassette.syncCursor();
  }

  eject(): void { this.cassette.eject(); }

  /**
   * The most recent SAVE since reset, as the image LOAD reads back: a ZX81
   * `.p` (VERSN up to E_LINE) named after the program, or a ZX80 `.o` ($4000
   * up to E_LINE). A SAVE the ROM wrote in real time is decoded from the
   * pulses on the MIC line; one the trap served was captured directly. The
   * trap clears the MIC capture, so whichever there is is the latest.
   */
  recordedBytes(): { data: Uint8Array; filename: string } | null {
    const m = this.machine;
    const model = m.model;
    const pulses = m.micRecorder.pulses(m.cpu.tStates);
    const decoded = decodeZx8xPulses(model, pulses, TAPE_REF_HZ / ZX8X_CPU_CLOCK);
    const saved = decoded.length > 0 ? decoded[decoded.length - 1] : m.lastSave;
    if (!saved) return null;
    if (model === 'zx80') return { data: saved.data.slice(), filename: 'zx80.o' };
    const base = saved.name.replace(UNSAFE_FILENAME, '_').trim();
    return { data: saved.data.slice(), filename: `${base || 'zx81'}.p` };
  }
}
