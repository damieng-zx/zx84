/**
 * Spectrum TapeService — cassette transport over the shared pulse-level
 * TapeDeck, folding in the Spectrum-specific loader-detector interplay:
 * a user-initiated stop/pause must block the LoaderDetector from auto-
 * restarting playback on post-load keyboard polling.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { parseCSW } from '@/media/tape/csw.ts';

/** One-line pane label for a tape block (data blocks show flag + length). */
export function tapeBlockInfo(b: TapeBlock, index: number): TapeBlockInfo {
  let label: string;
  switch (b.kind) {
    case 'data':
      label = `${b.flag === 0x00 ? 'Header' : 'Data'} (${b.data.length} bytes)`;
      break;
    case 'group-start': label = b.name; break;
    case 'text': label = b.text; break;
    case 'pause': label = `Pause ${b.duration}ms`; break;
    default: label = b.kind; break;
  }
  return { index, label, kind: b.kind === 'data' ? b.source : b.kind };
}

export class SpectrumTapeService implements TapeService {
  /** Mounted filename — media identity is service state; the deck only holds
   *  blocks. Set by MediaService on mount, cleared on eject. */
  private _name = '';

  constructor(private readonly s: Spectrum) {}

  get loaded(): boolean { return this.s.tape.blocks.length > 0; }
  get name(): string { return this._name; }
  get blocks(): readonly TapeBlockInfo[] { return this.s.tape.blocks.map(tapeBlockInfo); }
  get rawBlocks(): readonly TapeBlock[] { return this.s.tape.blocks; }
  get position(): number { return this.s.tape.position; }
  get playing(): boolean { return this.s.tape.playing; }
  get paused(): boolean { return this.s.tape.paused; }

  /** Put a parsed tape on the deck: positioned at the start, motor running but
   *  pause held — like pressing PLAY with the pause button down (the ROM
   *  loader or the user releases it). */
  mountBlocks(blocks: TapeBlock[], name: string): void {
    this.s.tape.blocks = blocks;
    this.s.tape.position = 0;
    this.s.tape.paused = true;
    this.s.tape.startPlayback();
    this._name = name;
  }

  play(): void {
    this.s.loaderDetector.userOverride = false;
    this.s.tape.paused = false;
    this.s.tape.startPlayback();
  }

  pause(): void {
    this.s.tape.paused = true;
    this.s.loaderDetector.userOverride = true;
  }

  resume(): void {
    // Clears pause mid-block — no startPlayback(), which would re-begin the
    // current block from its pilot tone.
    this.s.tape.paused = false;
    this.s.loaderDetector.userOverride = false;
  }

  stop(): void {
    // User-initiated stop — block the LoaderDetector from auto-restarting on
    // post-load keyboard polling. Cleared on the next manual play.
    this.s.loaderDetector.userOverride = true;
    this.s.tape.stopPlayback();
  }

  rewind(): void { this.s.tape.rewind(); }

  seek(block: number): void { this.s.tape.position = block; }

  eject(): void {
    this.s.tape.stopPlayback();
    this.s.tape.blocks = [];
    this.s.tape.position = 0;
    this.s.tape.paused = true;
    this._name = '';
  }

  /** Parse + mount persisted tape bytes at the start, paused and not playing —
   *  the reload-restore path (distinct from a MediaService mount, which starts
   *  the motor with pause held). */
  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    let blocks: TapeBlock[];
    try {
      const ext = name.toLowerCase().split('.').pop();
      blocks = ext === 'tzx' || ext === 'cdt' ? parseTZX(data)
        : ext === 'csw' ? await parseCSW(data)
        : this.s.tape.parseTAP(data);
    } catch {
      return false;
    }
    this.s.tape.blocks = blocks;
    this.s.tape.position = 0;
    this.s.tape.paused = true;
    this._name = name;
    return true;
  }

  stashState(): TapeStashState | null {
    return {
      blocks: [...this.s.tape.blocks],
      position: this.s.tape.position,
      paused: this.s.tape.paused,
    };
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (!state.blocks || state.blocks.length === 0) return;
    this.s.tape.blocks = state.blocks;
    this.s.tape.position = state.position ?? 0;
    this.s.tape.paused = state.paused ?? true;
    this._name = name;
  }
}
