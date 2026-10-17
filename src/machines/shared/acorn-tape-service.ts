/**
 * TapeService for the Acorn machines (BBC Micro, Electron): the transport and
 * file handling over a shared `CassetteDrive`. UEF and CSW images both play at
 * the pulse level; the machine's own receiver decodes them.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { looksLikeUef, parseUEF } from '@/media/tape/uef.ts';
import { parseCSW } from '@/media/tape/csw.ts';
import { tapeBlockInfo } from './tape-block-info.ts';
import type { CassetteDrive } from './cassette-drive.ts';

export const ACORN_TAPE_EXTENSIONS = ['.uef', '.csw'] as const;

/** Parse a UEF or CSW image. The content decides, not the file name: a UEF
 *  signature (or gzip wrapper) is UEF, anything else is tried as CSW. */
export async function parseAcornTape(data: Uint8Array): Promise<TapeBlock[]> {
  return looksLikeUef(data) ? parseUEF(data) : parseCSW(data);
}

export class AcornTapeService implements TapeService {
  constructor(
    private readonly drive: CassetteDrive,
    /** Name of the file to offer for the Save menu's recorded tape. */
    private readonly saveName: string,
  ) {}

  get loaded(): boolean { return this.drive.loaded; }
  get name(): string { return this.drive.name; }
  get blocks(): readonly TapeBlockInfo[] { return this.drive.deck.blocks.map(tapeBlockInfo); }
  get rawBlocks(): readonly TapeBlock[] { return this.drive.deck.blocks; }
  get position(): number { return this.drive.deck.position; }
  get playing(): boolean { return this.drive.deck.playing; }
  get paused(): boolean { return this.drive.userPaused; }

  /** Parse and mount a tape image (UEF, gzipped UEF or CSW). */
  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    let blocks: TapeBlock[];
    try {
      blocks = await parseAcornTape(data);
    } catch {
      return false;
    }
    if (blocks.length === 0) return false;
    this.drive.mount(blocks, name);
    return true;
  }

  stashState(): TapeStashState | null {
    if (!this.drive.loaded) return null;
    return {
      blocks: [...this.drive.deck.blocks],
      position: this.drive.deck.position,
      paused: this.drive.userPaused,
    };
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (!state.blocks || state.blocks.length === 0) return;
    this.drive.mount(state.blocks, name);
    this.drive.deck.position = state.position ?? 0;
    this.drive.userPaused = state.paused ?? false;
    this.drive.applyRun();
  }

  play(): void {
    this.drive.userPaused = false;
    this.drive.fsk.reset();
    this.drive.deck.startPlayback();
    this.drive.applyRun();
  }

  pause(): void {
    this.drive.userPaused = true;
    this.drive.applyRun();
  }

  resume(): void {
    this.drive.userPaused = false;
    this.drive.applyRun();
  }

  stop(): void {
    this.drive.deck.stopPlayback();
    this.drive.fsk.reset();
  }

  rewind(): void {
    this.drive.deck.rewind();
    this.drive.fsk.reset();
  }

  seek(block: number): void {
    const deck = this.drive.deck;
    deck.position = Math.max(0, Math.min(block, deck.blocks.length));
    if (deck.playing) deck.startPlayback();
    this.drive.fsk.reset();
  }

  eject(): void { this.drive.eject(); }

  /** What the machine has written to the cassette port, as a UEF. */
  recordedBytes(): { data: Uint8Array; filename: string } | null {
    const data = this.drive.recorder.toUef();
    return data ? { data, filename: this.saveName } : null;
  }
}
