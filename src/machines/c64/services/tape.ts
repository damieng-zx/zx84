/**
 * C64TapeService — the Datasette over the shared pulse deck.
 *
 * The deck's `playing` is the PLAY button. A mounted tape starts with it up
 * and it goes down by itself when a program waits for it; an empty deck
 * stands for a blank cassette with RECORD and PLAY down, so SAVE just works.
 * With a button down the KERNAL drives the motor (6510 port bit 5), and the
 * motor is what moves the tape. Play/stop here are the deck's own buttons.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { tapeBlockInfo } from '@/machines/shared/tape-block-info.ts';
import {
  encodeC64Tap, halvesToPulses, parseC64Tap, type C64TapeFile,
} from '@/media/tape/c64-tap.ts';
import type { C64Machine } from '../c64-machine.ts';

export class C64TapeService implements TapeService {
  private _name = '';
  private _files: readonly C64TapeFile[] = [];

  constructor(private readonly m: C64Machine) {}

  get loaded(): boolean { return this.m.tape.blocks.length > 0; }
  get name(): string { return this._name; }
  get blocks(): readonly TapeBlockInfo[] { return this.m.tape.blocks.map(tapeBlockInfo); }
  get rawBlocks(): readonly TapeBlock[] { return this.m.tape.blocks; }
  get position(): number { return this.m.tape.position; }
  get playing(): boolean { return this.m.tape.playing; }
  get paused(): boolean { return this.m.tape.paused; }

  /** The KERNAL files found on the mounted tape. */
  get files(): readonly C64TapeFile[] { return this._files; }

  /** Mount a .tap at its start with PLAY up; it goes down when a program
   *  waits for it (see `C64Machine.armAutoPlay`), and the motor moves it. */
  mount(data: Uint8Array, name: string): boolean {
    const tape = parseC64Tap(data);
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
    return { data, filename: `${name || 'c64'}.tap` };
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
