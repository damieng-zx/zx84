/**
 * Acorn Atom cassette transport.
 *
 * The Atom has no motor relay: the tape runs while the user has it playing, and
 * the OS's own bit-banged UART reads the cassette input on PPI port C bit 5
 * (with the interface's 2400 Hz tone on bit 4 for the save path). The deck
 * therefore feeds the raw UEF/CSW/WAVE pulse level straight to the machine; no
 * FSK demodulator or motor line sits in between.
 *
 * Atom UEFs are usually 300 baud, often omit the UEF 0x0117 baud chunk, carry
 * a measured ~1226 Hz base frequency rather than the nominal 1200 Hz, and mark
 * their data with a negative stop-bit count whose extra "short wave" is a BBC
 * convention the Atom's plain 8N1 receiver does not expect. The parser is
 * therefore told 300 baud, a fixed 1200 Hz base and no short wave; a 0x0117
 * chunk in the file still wins on baud.
 */

import { TapeDeck, TAPE_REF_HZ, type TapeBlock } from '@/media/tape/tap.ts';
import { looksLikeUef, parseUEF } from '@/media/tape/uef.ts';
import { parseCSW } from '@/media/tape/csw.ts';
import { isWav, wavToPulseBlocks } from '@/media/tape/wav.ts';
import { tapeBlockInfo } from '@/machines/shared/tape-block-info.ts';
import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import { ATOM_CPU_CLOCK } from './constants.ts';

export const ATOM_TAPE_EXTENSIONS = ['.uef', '.csw', '.wav'] as const;

/** Parse an Atom tape. UEF is decoded at the Atom's 300-baud default; a raw
 *  CSW or WAVE capture already carries its own waveform. */
export async function parseAtomTape(data: Uint8Array): Promise<TapeBlock[]> {
  if (looksLikeUef(data)) {
    return parseUEF(data, { defaultBaud: 300, fixedBaseHz: 1200, noShortWave: true });
  }
  return isWav(data) ? wavToPulseBlocks(data) : parseCSW(data);
}

export class AtomTape implements TapeService {
  readonly deck = new TapeDeck(ATOM_CPU_CLOCK);
  name = '';
  /** The user paused the transport. */
  private userPaused = false;
  /** Cassette-input level changes since the probe last consumed them. The EAR
   *  lamp shows activity, not the idle-high line. */
  private earEdges = 0;

  constructor() {
    // UEF/CSW pulses are authored in 3.5 MHz ticks; the Atom's CPU counts at
    // 1 MHz, so scale them into its T-states.
    this.deck.pulseScale = ATOM_CPU_CLOCK / TAPE_REF_HZ;
  }

  get loaded(): boolean { return this.deck.blocks.length > 0; }
  get blocks(): readonly TapeBlockInfo[] { return this.deck.blocks.map(tapeBlockInfo); }
  get rawBlocks(): readonly TapeBlock[] { return this.deck.blocks; }
  get position(): number { return this.deck.position; }
  get playing(): boolean { return this.deck.playing && !this.deck.paused; }
  get paused(): boolean { return this.userPaused; }
  get finished(): boolean { return this.deck.finished; }

  /** Cassette input on PPI port C bit 5: the raw deck level while moving, and
   *  the idle-high level when stopped (so the OS's transition counter times
   *  out rather than seeing phantom bits). */
  get inputBit(): number {
    return this.deck.playing && !this.deck.paused ? this.deck.earBit : 1;
  }

  /** Advance the deck by `elapsed` CPU cycles. */
  advance(elapsed: number): void {
    if (!this.deck.playing || this.deck.paused) return;
    const before = this.deck.earBit;
    this.deck.advance(elapsed);
    if (this.deck.earBit !== before) this.earEdges++;
  }

  /** Take the tape's level-change count for the frame probe's EAR lamp. */
  takeEarEdges(): number {
    const edges = this.earEdges;
    this.earEdges = 0;
    return edges;
  }

  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    let blocks: TapeBlock[];
    try {
      blocks = await parseAtomTape(data);
    } catch {
      return false;
    }
    if (blocks.length === 0) return false;
    this.mount(blocks, name);
    return true;
  }

  private mount(blocks: TapeBlock[], name: string): void {
    this.deck.blocks = blocks;
    this.deck.position = 0;
    this.deck.paused = false;
    this.name = name;
    this.userPaused = false;
    this.deck.startPlayback();
  }

  stashState(): TapeStashState | null {
    if (!this.loaded) return null;
    return {
      blocks: [...this.deck.blocks],
      position: this.deck.position,
      paused: this.userPaused,
    };
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (!state.blocks || state.blocks.length === 0) return;
    this.mount(state.blocks, name);
    this.deck.position = state.position ?? 0;
    this.userPaused = state.paused ?? false;
    this.deck.paused = this.userPaused;
    if (!this.userPaused) this.deck.startPlayback();
  }

  play(): void {
    this.userPaused = false;
    this.deck.paused = false;
    if (!this.deck.playing) this.deck.startPlayback();
  }

  pause(): void {
    this.userPaused = true;
    this.deck.paused = true;
  }

  resume(): void {
    this.userPaused = false;
    this.deck.paused = false;
  }

  stop(): void {
    this.deck.stopPlayback();
    this.userPaused = false;
  }

  rewind(): void {
    this.deck.rewind();
  }

  seek(block: number): void {
    this.deck.position = Math.max(0, Math.min(block, this.deck.blocks.length));
    if (this.deck.playing) this.deck.startPlayback();
  }

  eject(): void {
    this.deck.stopPlayback();
    this.deck.blocks = [];
    this.deck.position = 0;
    this.name = '';
    this.userPaused = false;
    this.earEdges = 0;
  }

  /** Power-on/reset: the tape stops and rewinds but stays in the deck, as a
   *  real cassette would. */
  reset(): void {
    this.deck.stopPlayback();
    this.deck.rewind();
    this.userPaused = false;
    this.earEdges = 0;
  }
}
