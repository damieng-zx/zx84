/**
 * The pulse-level tape service every `TapeDeck` machine shares.
 *
 * The Spectrum, the CPC, the Einstein and the rest differ in a great many ways,
 * but a tape transport over a shared `TapeDeck` is the same object on all of
 * them:
 *
 *   - the mounted filename (media identity is service state; the deck holds only
 *     blocks) and the deck's own position/playing/paused flags;
 *   - mount (position at the start, motor running with pause held, like pressing
 *     PLAY with the pause button down), eject, seek and rewind;
 *   - "parse + mount persisted bytes", which every format the deck understands
 *     goes through — the reload-restore path;
 *   - the stash, which is a snapshot of the deck, for the pane to restore;
 *   - what the machine SAVEd, as a tape file, from its own pulse recorder.
 *
 * What differs is supplied by the machine, and it is little: the deck itself,
 * its pulse recorder's clock, the save codec, and — on the Spectrum only — the
 * loader-detector interplay that decides whether a stop or pause may be undone
 * by the ROM's own post-load keyboard polling.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock, TapeDeck } from '@/media/tape/tap.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { parseCSW } from '@/media/tape/csw.ts';
import { wavToPulseBlocks } from '@/media/tape/wav.ts';
import { tapeBlockInfo } from '@/machines/shared/tape-block-info.ts';

/**
 * The loader-detector handshake, on the machines that have one.
 *
 * When the machine's ROM notices a tape and starts its own loader, it plays the
 * tape itself; when it notices the loader has finished, it keeps polling the
 * EAR line. A user who has just pressed STOP or PAUSE must not have the machine
 * restart playback underneath them, so those set `userOverride`, and a manual
 * play clears it again.
 */
export interface TapeLoaderOverride {
  /** Set while a user-initiated stop/pause should hold the loader off. */
  userOverride: boolean;
  /** The machine's own "a tape read just happened" bookkeeping, re-based so a
   *  resume does not look like a fresh start. */
  resetAdvance(): void;
}

export interface DeckTapeServiceOptions {
  /** The machine's pulse-level deck. */
  deck: TapeDeck;
  /** Parse a TAP image (the deck's own reader, or the machine's own format). */
  parseTap: (data: Uint8Array) => TapeBlock[];
  /** The machine's save codec: recorder pulses → a tape file, or null when
   *  nothing recognisable was written. */
  save: (pulses: ArrayLike<number>) => { data: Uint8Array; filename: string } | null;  /** The recorder pulses to hand `save`. */
  recordedPulses: () => ArrayLike<number>;
  /** Tag a freshly parsed tape before it mounts — the machines whose files carry
   *  a name/type pair the pane should list as the load line (the Ace). */
  tagBlocks?: (blocks: TapeBlock[]) => void;
  /** Present on a machine whose ROM runs its own loader (the Spectrum, the Ace). */
  loaderOverride?: TapeLoaderOverride;
}

export class DeckTapeService implements TapeService {
  /** Mounted filename — media identity is service state; the deck only holds
   *  blocks. Set on mount, cleared on eject. */
  private _name = '';

  constructor(private readonly o: DeckTapeServiceOptions) {}

  private get deck(): TapeDeck { return this.o.deck; }

  get loaded(): boolean { return this.deck.blocks.length > 0; }
  get name(): string { return this._name; }
  get blocks(): readonly TapeBlockInfo[] { return this.deck.blocks.map(tapeBlockInfo); }
  get rawBlocks(): readonly TapeBlock[] { return this.deck.blocks; }
  get position(): number { return this.deck.position; }
  get playing(): boolean { return this.deck.playing; }
  get paused(): boolean { return this.deck.paused; }

  /** Put a parsed tape on the deck: positioned at the start, motor running but
   *  pause held — like pressing PLAY with the pause button down (the ROM loader
   *  or the user releases it). */
  mountBlocks(blocks: TapeBlock[], name: string): void {
    this.o.tagBlocks?.(blocks);
    this.deck.blocks = blocks;
    this.deck.position = 0;
    this.deck.paused = true;
    this.deck.startPlayback();
    this._name = name;
  }

  play(): void {
    const lo = this.o.loaderOverride;
    if (lo) lo.userOverride = false;
    this.deck.paused = false;
    this.deck.startPlayback();
    lo?.resetAdvance();
  }

  pause(): void {
    this.deck.paused = true;
    if (this.o.loaderOverride) this.o.loaderOverride.userOverride = true;
  }

  resume(): void {
    // Clears pause mid-block — no startPlayback(), which would re-begin the
    // current block from its pilot tone.
    this.deck.paused = false;
    const lo = this.o.loaderOverride;
    if (lo) { lo.userOverride = false; lo.resetAdvance(); }
  }

  stop(): void {
    // A user-initiated stop must block the loader from auto-restarting on
    // post-load keyboard polling. Cleared on the next manual play.
    if (this.o.loaderOverride) this.o.loaderOverride.userOverride = true;
    this.deck.stopPlayback();
  }

  rewind(): void { this.deck.rewind(); }

  seek(block: number): void { this.deck.position = block; }

  eject(): void {
    this.deck.stopPlayback();
    this.deck.blocks = [];
    this.deck.position = 0;
    this.deck.paused = true;
    this._name = '';
  }

  /** Parse + mount persisted tape bytes at the start, paused and not playing —
   *  the reload-restore path (distinct from a MediaService mount, which starts
   *  the motor with pause held). */
  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    let blocks: TapeBlock[];
    try {
      const ext = name.toLowerCase().split('.').pop() ?? '';
      blocks = ext === 'tzx' || ext === 'cdt' ? parseTZX(data)
        : ext === 'csw' ? await parseCSW(data)
        : ext === 'wav' ? wavToPulseBlocks(data)
        : this.o.parseTap(data);
    } catch {
      return false;
    }
    this.o.tagBlocks?.(blocks);
    this.deck.blocks = blocks;
    this.deck.position = 0;
    this.deck.paused = true;
    this._name = name;
    return true;
  }

  /** What the machine has SAVEd since the last reset, as a tape file, or null
   *  when nothing recognisable was written. The ROM (or any saver of the user's
   *  own) drives the cassette output and the recorder times it — so this is
   *  whatever the machine actually wrote. */
  recordedBytes(): { data: Uint8Array; filename: string } | null {
    return this.o.save(this.o.recordedPulses());
  }

  stashState(): TapeStashState | null {
    return {
      blocks: [...this.deck.blocks],
      position: this.deck.position,
      paused: this.deck.paused,
    };
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (!state.blocks || state.blocks.length === 0) return;
    this.deck.blocks = state.blocks;
    this.deck.position = state.position ?? 0;
    this.deck.paused = state.paused ?? true;
    this._name = name;
  }
}
