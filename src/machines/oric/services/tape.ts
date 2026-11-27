/**
 * OricTapeService — the cassette transport over the machine's deck.
 *
 * A `.tap` is the decoded byte stream, so the transport has no blocks to seek:
 * the tape is one signal, produced by the encoder from the image's files and
 * played at the ROM's own pace. What makes the pane useful is the block list,
 * which names each file on the tape, and `recordedBytes`, which hands back
 * whatever the ROM has SAVEd since the last reset.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import type { OricTapFile } from '@/media/tape/oric-tap.ts';
import { buildOricTap, isOricTap, parseOricTap } from '@/media/tape/oric-tap.ts';
import type { OricMachine } from '../oric-machine.ts';

/** The command that loads the tape's first file, for the mount message. */
function loadHint(files: readonly OricTapFile[]): string {
  const first = files[0];
  if (!first) return 'CLOAD ""';
  return `CLOAD "${first.name}"`;
}

export class OricTapeService implements TapeService {
  private _name = '';
  private _files: readonly OricTapFile[] = [];

  constructor(private readonly m: OricMachine) {}

  get loaded(): boolean { return this.m.tape.loaded; }
  get name(): string { return this._name; }
  get blocks(): readonly TapeBlockInfo[] {
    // One entry per file on the tape, named and sized as the loader sees it.
    return this._files.map((file, index) => ({
      index,
      label: file.name || '(unnamed)',
      kind: file.type === 0x00 ? 'basic' : 'data',
      detail: `${file.type === 0x00 ? 'BASIC' : 'Machine code'} — ${file.data.length} bytes ` +
        `at $${file.start.toString(16)}`,
      name: file.name,
      type: file.type === 0x00 ? 'BASIC' : 'Machine code',
      size: file.data.length,
    }));
  }
  get rawBlocks(): readonly TapeBlock[] {
    return this.m.tape.loaded ? this.m.tape.encoder.encode(this._files) : [];
  }
  get position(): number { return this.m.tape.position; }
  get playing(): boolean { return this.m.tape.playing; }
  get paused(): boolean { return this.m.tape.paused; }

  /** What is on the mounted tape, for the mount message. */
  get files(): readonly OricTapFile[] { return this._files; }

  /** The command that loads the tape's first file. */
  get command(): string { return loadHint(this._files); }

  /**
   * Mount a `.tap`. It sits paused until the ROM spins the motor, which is what
   * a real deck does under a `CLOAD`.
   */
  mount(data: Uint8Array, name: string): boolean {
    if (!isOricTap(data)) return false;
    let files: OricTapFile[];
    try {
      files = parseOricTap(data);
    } catch {
      return false;
    }
    if (files.length === 0) return false;
    this._files = files;
    this._name = name;
    this.m.tape.name = name;
    if (!this.m.tape.mount(this.m.tape.encoder.encode(files))) return false;
    this.m.tape.paused = true;
    this.m.tape.playing = false;
    return true;
  }

  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    return this.mount(data, name);
  }

  play(): void {
    this.m.tape.paused = false;
    if (!this.m.tape.loaded) return;
    this.m.tape.playing = true;
  }

  pause(): void { this.m.tape.paused = true; this.m.tape.playing = false; }
  resume(): void { this.m.tape.paused = false; this.m.tape.playing = true; }
  stop(): void { this.m.tape.paused = true; this.m.tape.playing = false; }
  rewind(): void { this.m.tape.reset(); }
  seek(_block: number): void {
    // One continuous signal: there is nothing to seek to.
  }

  eject(): void {
    this.m.tape.eject();
    this._files = [];
    this._name = '';
  }

  /**
   * What the ROM has SAVEd since the last reset.
   *
   * The recorder holds the raw edge intervals of the signal the ROM drove out
   * of PB7. Those are decoded back to bytes with the same frame the encoder
   * writes (start 0, eight data bits, parity, three stop 1s) and then framed as
   * a `.tap`, so the export is a tape this machine — and any Oric — can load
   * back. Returning the raw pulse lengths would produce a file no loader
   * understands, which is worse than returning nothing.
   */
  recordedBytes(): { data: Uint8Array; filename: string } | null {
    const pulses = this.m.tape.recorder.pulses(this.m.cpu.tStates);
    if (pulses.length === 0) return null;
    const files = decodeSavedTape(pulses);
    if (files.length === 0) return null;
    const first = files[0];
    const stem = (first.name || 'oric').replace(/[^A-Za-z0-9 _.-]/g, '').trim() || 'oric';
    return { data: buildOricTap(files), filename: `${stem}.tap` };
  }

  stashState(): TapeStashState | null {
    if (!this.m.tape.loaded || this._files.length === 0) return null;
    return {
      blocks: [...this.rawBlocks],
      position: this.m.tape.position,
      paused: this.m.tape.paused,
      casData: buildOricTap(this._files),
    };
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (!state.casData) return;
    this.mount(state.casData, name);
  }
}

/**
 * Decode a recorded SAVE signal back to files.
 *
 * **Unverified — this returns nothing today.** The recorded signal is sound: the
 * ROM's `CSAVE` drives PB7 through the VIA's timer and the recorder captures the
 * two half-cycle populations cleanly (~209 cycles at 2400 Hz and ~417 at
 * 1200 Hz, measured on the real BASIC 1.1 ROM). What is *not* yet established is
 * how the ROM frames bits across those tones: a first attempt assuming eight
 * periods to a bit produced no clean 13-bit frames.
 *
 * Returning nothing is deliberate. The Save menu then reports "nothing saved"
 * instead of writing a `.tap` that no loader can read — a corrupt export that
 * looks successful is worse than an absent one. `tests/oric-tape.test.ts` pins
 * the measured half-cycle lengths so the next attempt starts from evidence
 * rather than from the reference's one-line summary.
 */
export function decodeSavedTape(pulses: Uint32Array): OricTapFile[] {
  if (pulses.length === 0) return [];
  return [];
}
