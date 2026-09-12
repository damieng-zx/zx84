/**
 * Ace TapeService — cassette transport over the shared pulse-level TapeDeck,
 * folding in the loader-detector interplay: a user-initiated stop/pause must
 * block the LoaderDetector from auto-restarting playback on post-load keyboard
 * polling (same contract as the Spectrum's deck service).
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { DataBlock, TapeBlock } from '@/media/tape/tap.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { parseCSW } from '@/media/tape/csw.ts';
import { tapeBlockInfo } from '@/machines/shared/tape-block-info.ts';
import { parseAceTap, parseAceTapeHeader, tagAceTapeFiles } from '../ace-tape.ts';
import { decodeAceSaveToTap } from '../ace-tape-save.ts';
import type { JupiterAceMachine } from '../ace-machine.ts';

export class AceTapeService implements TapeService {
  /** Mounted filename — media identity is service state; the deck only holds
   *  blocks. Set by MediaService on mount, cleared on eject. */
  private _name = '';

  constructor(private readonly m: JupiterAceMachine) {}

  get loaded(): boolean { return this.m.tape.blocks.length > 0; }
  get name(): string { return this._name; }
  get blocks(): readonly TapeBlockInfo[] { return this.m.tape.blocks.map(tapeBlockInfo); }
  get rawBlocks(): readonly TapeBlock[] { return this.m.tape.blocks; }
  get position(): number { return this.m.tape.position; }
  get playing(): boolean { return this.m.tape.playing; }
  get paused(): boolean { return this.m.tape.paused; }

  /** Put a parsed tape on the deck: positioned at the start, motor running but
   *  pause held — like pressing PLAY with the pause button down (the ROM
   *  loader or the user releases it). Ace header/data pairs are tagged so the
   *  pane shows LOAD/BLOAD "name" entries. */
  mountBlocks(blocks: TapeBlock[], name: string): void {
    tagAceTapeFiles(blocks);
    this.m.tape.blocks = blocks;
    this.m.tape.position = 0;
    this.m.tape.paused = true;
    this.m.tape.startPlayback();
    this._name = name;
  }

  play(): void {
    this.m.loaderDetector.userOverride = false;
    this.m.tape.paused = false;
    this.m.tape.startPlayback();
  }

  pause(): void {
    this.m.tape.paused = true;
    this.m.loaderDetector.userOverride = true;
  }

  resume(): void {
    // Clears pause mid-block — no startPlayback(), which would re-begin the
    // current block from its pilot tone.
    this.m.tape.paused = false;
    this.m.loaderDetector.userOverride = false;
  }

  stop(): void {
    // User-initiated stop — block the LoaderDetector from auto-restarting on
    // post-load keyboard polling. Cleared on the next manual play.
    this.m.loaderDetector.userOverride = true;
    this.m.tape.stopPlayback();
  }

  rewind(): void { this.m.tape.rewind(); }

  seek(block: number): void { this.m.tape.position = block; }

  eject(): void {
    this.m.tape.stopPlayback();
    this.m.tape.blocks = [];
    this.m.tape.position = 0;
    this.m.tape.paused = true;
    this._name = '';
  }

  /** Parse + mount persisted tape bytes at the start, paused and not playing —
   *  the reload-restore path (distinct from a MediaService mount, which starts
   *  the motor with pause held). Ace .tap chunks are flag-less (the block type
   *  is the chunk length), so they go through the Ace parser, not the
   *  Spectrum's parseTAP. */
  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    let blocks: TapeBlock[];
    try {
      const ext = name.toLowerCase().split('.').pop();
      blocks = ext === 'tzx' ? parseTZX(data)
        : ext === 'csw' ? await parseCSW(data)
        : parseAceTap(data);
    } catch {
      return false;
    }
    tagAceTapeFiles(blocks);
    this.m.tape.blocks = blocks;
    this.m.tape.position = 0;
    this.m.tape.paused = true;
    this._name = name;
    return true;
  }

  /** What the machine has SAVEd since the last reset, as .tap bytes, or null
   *  when nothing has been written to the cassette port. The ROM's own SAVE
   *  routine drives the MIC line and the recorder times it — see
   *  ace-tape-save.ts — so this is whatever the machine actually wrote,
   *  including from a program of the user's own. */
  recordedBytes(): { data: Uint8Array; filename: string } | null {
    const data = decodeAceSaveToTap(this.m.tapeRecorder.edges);
    if (!data) return null;
    // Name it after the first file on it, as the Ace itself would.
    const blocks = parseAceTap(data);
    const header = blocks.find(b => b.kind === 'data' && (b as DataBlock).flag === 0x00) as DataBlock | undefined;
    const name = header ? parseAceTapeHeader(header.data)?.name ?? '' : '';
    return { data, filename: `${name || 'jupiter-ace'}.tap` };
  }

  stashState(): TapeStashState | null {
    return {
      blocks: [...this.m.tape.blocks],
      position: this.m.tape.position,
      paused: this.m.tape.paused,
    };
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (!state.blocks || state.blocks.length === 0) return;
    this.m.tape.blocks = state.blocks;
    this.m.tape.position = state.position ?? 0;
    this.m.tape.paused = state.paused ?? true;
    this._name = name;
  }
}
