/**
 * CbmTapeService — the Datasette over the shared pulse deck, for any
 * Commodore with a cassette port (the C64, the VIC-20).
 *
 * The deck's `playing` is the PLAY button. A mounted tape starts with it up
 * and it goes down by itself when a program waits for it; an empty deck
 * stands for a blank cassette with RECORD and PLAY down, so SAVE just works.
 * With a button down the KERNAL drives the motor (the 6510's port bit 5 on
 * the 64), and the motor is what moves the tape. Play/stop here are the deck's own buttons.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock, TapeDeck } from '@/media/tape/tap.ts';
import type { PulseRecorder } from '@/media/tape/pulse-recorder.ts';
import { tapeBlockInfo } from '@/machines/shared/tape-block-info.ts';
import {
  encodeC64Tap, encodeKernalTap, halvesToPulses, isC64Tap, parseC64Tap, type C64TapeFile,
} from '@/media/tape/c64-tap.ts';
import { isT64, parsePrg, parseT64 } from '@/media/tape/t64.ts';

/** What the tape service needs of the computer the Datasette is plugged into. */
export interface CbmTapeHost {
  /** The tape, played through the shared pulse deck. */
  readonly tape: TapeDeck;
  /** Edges of the cassette write line since the last reset (what SAVE wrote). */
  readonly tapeRecorder: PulseRecorder;
  /** The tape was mounted, ejected, played or stopped. */
  tapeTransportChanged(): void;
  /** Press PLAY the first time software sits waiting for it. */
  armAutoPlay(): void;
}

export class CbmTapeService implements TapeService {
  private _name = '';
  private _files: readonly C64TapeFile[] = [];

  /** `fallbackName` names a recording whose first file has no name. */
  constructor(private readonly m: CbmTapeHost, private readonly fallbackName: string) {}

  get loaded(): boolean { return this.m.tape.blocks.length > 0; }
  get name(): string { return this._name; }
  get blocks(): readonly TapeBlockInfo[] { return this.m.tape.blocks.map(tapeBlockInfo); }
  get rawBlocks(): readonly TapeBlock[] { return this.m.tape.blocks; }
  get position(): number { return this.m.tape.position; }
  get playing(): boolean { return this.m.tape.playing; }
  get paused(): boolean { return this.m.tape.paused; }

  /** The KERNAL files found on the mounted tape. */
  get files(): readonly C64TapeFile[] { return this._files; }

  /**
   * What `data` is as a .tap: a .tap itself, or a .t64 / .prg, which stand
   * for a recording of their programs as the KERNAL would have SAVEd them (so
   * they list in the Tape pane, and LOAD finds them). Null when it is none.
   */
  private asTap(data: Uint8Array, name: string): Uint8Array | null {
    if (isC64Tap(data)) return data;
    if (isT64(data)) {
      const programs = parseT64(data).filter(p => p.data.length > 0);
      return programs.length > 0 ? encodeKernalTap(programs) : null;
    }
    if (/\.prg$/i.test(name)) {
      return encodeKernalTap([parsePrg(data, name.replace(/^.*[\\/]/, '').replace(/\.prg$/i, ''))]);
    }
    return null;
  }

  /** Mount a .tap (or the recording of a .t64 / .prg) at its start with PLAY
   *  up; it goes down when a program waits for it (see
   *  `CbmTapeHost.armAutoPlay`), and the motor moves it. */
  mount(data: Uint8Array, name: string): boolean {
    const tap = this.asTap(data, name);
    if (!tap) return false;
    const tape = parseC64Tap(tap);
    if (tape.pulses.length === 0) return false;
    const deck = this.m.tape;
    deck.stopPlayback();
    deck.blocks = tape.blocks;
    deck.position = 0;
    deck.paused = true;
    this._files = tape.files;
    this._name = name;
    this.m.tapeTransportChanged();
    this.m.armAutoPlay();
    return true;
  }

  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    try {
      return this.mount(data, name);
    } catch {
      return false;
    }
  }

  play(): void {
    this.m.tape.startPlayback();
    this.m.tapeTransportChanged();
  }

  pause(): void { this.m.tape.paused = true; }

  resume(): void {
    if (!this.m.tape.playing) this.m.tape.startPlayback();
    this.m.tape.paused = false;
    this.m.tapeTransportChanged();
  }

  stop(): void {
    this.m.tape.stopPlayback();
    this.m.tapeTransportChanged();
  }

  rewind(): void {
    this.m.tape.rewind();
    this.m.tapeTransportChanged();
  }

  seek(block: number): void { this.m.tape.position = block; }

  eject(): void {
    const deck = this.m.tape;
    deck.stopPlayback();
    deck.blocks = [];
    deck.position = 0;
    deck.paused = true;
    this._files = [];
    this._name = '';
    this.m.tapeTransportChanged();
  }

  /** What the machine has written to tape since the last reset, as a .tap. */
  recordedBytes(): { data: Uint8Array; filename: string } | null {
    const halves = this.m.tapeRecorder.pulses();
    if (halves.length < 2) return null;
    const data = encodeC64Tap(halvesToPulses(halves));
    const first = parseC64Tap(data).files[0]?.name ?? '';
    const name = first.replace(/[^A-Za-z0-9 _.-]/g, '').trim();
    return { data, filename: `${name || this.fallbackName}.tap` };
  }

  stashState(): TapeStashState | null {
    if (this.m.tape.blocks.length === 0) return null;
    return { blocks: [...this.m.tape.blocks], position: this.m.tape.position, paused: this.m.tape.paused };
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (!state.blocks || state.blocks.length === 0) return;
    const deck = this.m.tape;
    deck.blocks = state.blocks;
    deck.position = state.position ?? 0;
    deck.stopPlayback();
    deck.paused = true;
    this._name = name;
    this.m.tapeTransportChanged();
    this.m.armAutoPlay();
  }
}
