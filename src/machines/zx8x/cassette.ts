/**
 * The ZX80/ZX81 cassette deck: the shared pulse-level TapeDeck (whose level
 * the machine presents on bit 7 of a keyboard-port read) plus an index of the
 * programs its pulses carry, which the instant LOAD trap reads from.
 *
 * The index is found by decoding the tape's own pulses at mount
 * (tape-signal.ts), so a `.p` turned into pulses, a TZX block 0x19 and a WAVE
 * recording all give the trap the same thing: the program's name and image.
 * The trap keeps its own cursor through that list, so several programs in
 * one recording are read one after another just as the deck would play them.
 */

import { TapeDeck, TAPE_REF_HZ, type TapeBlock } from '@/media/tape/tap.ts';
import { ZX8X_CPU_CLOCK } from './constants.ts';
import {
  findZx8xPrograms, labelZx8xPrograms, type Zx8xDeckProgram, type Zx8xTapeModel,
} from './tape-signal.ts';

export class Zx8xCassette {
  readonly deck = new TapeDeck(ZX8X_CPU_CLOCK);
  /** Programs found on the tape, in tape order. */
  programs: readonly Zx8xDeckProgram[] = [];
  /** Mounted filename (media identity; the deck holds only blocks). */
  name = '';
  /** The user paused or stopped the deck: LOAD must not start it again until
   *  they press PLAY (or mount another tape). */
  userHold = false;
  private cursor = 0;
  /** Delivered to the next LOAD whatever name it asks for: the tape the user
   *  inserted while that LOAD was already waiting. */
  private cued: Zx8xDeckProgram | null = null;

  constructor(private readonly model: Zx8xTapeModel) {
    // Tape pulses are authored against the Spectrum's 3.5MHz clock.
    this.deck.pulseScale = ZX8X_CPU_CLOCK / TAPE_REF_HZ;
  }

  get loaded(): boolean { return this.deck.blocks.length > 0; }
  /** Playing and not paused: the signal is reaching the EAR input. */
  get running(): boolean { return this.deck.playing && !this.deck.paused; }

  /** Put a tape in the deck, stopped (at its start unless told otherwise).
   *  `known` lists the programs when the tape was made from images (so the
   *  trap reads them exactly, even an image too odd to decode); otherwise
   *  they are found by decoding the pulses. */
  mount(blocks: TapeBlock[], name: string, position = 0, known?: readonly Zx8xDeckProgram[]): void {
    const programs = known ?? findZx8xPrograms(this.model, blocks);
    if (!known) labelZx8xPrograms(this.model, blocks, programs);
    this.deck.stopPlayback();
    this.deck.blocks = blocks;
    this.deck.position = Math.min(position, blocks.length);
    this.deck.paused = true;
    this.programs = programs;
    this.name = name;
    this.userHold = false;
    this.cued = null;
    this.syncCursor();
  }

  eject(): void {
    this.deck.stopPlayback();
    this.deck.blocks = [];
    this.deck.position = 0;
    this.deck.paused = true;
    this.programs = [];
    this.name = '';
    this.cued = null;
    this.cursor = 0;
  }

  /** Make the first program on the tape the next LOAD's, whatever it asks. */
  cueFirst(): void {
    this.cued = this.programs[0] ?? null;
  }

  /** Mark a program as already read (it was loaded directly on mount). */
  markPlayed(program: Zx8xDeckProgram): void {
    this.cursor = this.programs.indexOf(program) + 1;
    const blocks = this.deck.blocks;
    let at = Math.min(program.endBlock + 1, blocks.length);
    // Step over the silence and labels that follow it, so a tape that has
    // nothing more on it reads as finished rather than playing its trailer.
    while (at < blocks.length) {
      const kind = blocks[at].kind;
      const quiet = (kind === 'pause' && (blocks[at] as { duration: number }).duration > 0)
        || kind === 'text' || kind === 'archive-info' || kind === 'group-start' || kind === 'group-end';
      if (!quiet) break;
      at++;
    }
    this.deck.position = at;
  }

  /** After the user moves the tape, the trap carries on from there. */
  syncCursor(): void {
    const at = this.programs.findIndex(p => p.startBlock >= this.deck.position);
    this.cursor = at < 0 ? this.programs.length : at;
  }

  /** True while blocks remain to play from the current position. */
  get unplayed(): boolean { return this.deck.position < this.deck.blocks.length; }

  /**
   * The program a LOAD asking for `name` (null: LOAD "", or any ZX80 LOAD)
   * reads: the next one on, or for a name the first match winding forward and
   * wrapping once. The tape is left after it.
   */
  take(name: string | null): Zx8xDeckProgram | null {
    let found: Zx8xDeckProgram | null = null;
    if (this.cued) {
      found = this.cued;
      this.cued = null;
    } else if (name === null) {
      found = this.programs[this.cursor] ?? null;
    } else {
      const wanted = name.toUpperCase().trim();
      const count = this.programs.length;
      for (let i = 0; i < count; i++) {
        const p = this.programs[(this.cursor + i) % count];
        if (p.name === wanted) { found = p; break; }
      }
    }
    if (found) this.markPlayed(found);
    return found;
  }
}
