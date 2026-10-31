/**
 * MSX TapeService — the cassette recorder, at two levels at once:
 *
 *  - the pulse-level deck (`m.tape`, the shared TapeDeck) plays the tape's
 *    signal into PSG register 14 bit 7, gated by the cassette motor relay
 *    (PPI port C bit 4). A `.cas` is played as its synthesised FSK signal
 *    (`casToPulseBlocks`), a `.tsx`/`.tzx` through the TZX parser (block 0x4B
 *    is MSX data), a `.wav` as recorded. Loaders that time the input
 *    themselves work from this.
 *  - a `.cas` is also kept as a byte stream (`m.cassette`) for the BIOS
 *    TAPION/TAPIN traps, which serve normal BIOS loads instantly while "Fast
 *    ROM loading" is on.
 *
 * The deck's blocks line up one-to-one with the `.cas` blocks, so a trapped
 * load moves the deck on to the block after the one it read.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { casToPulseBlocks } from '@/media/tape/cas.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { wavToPulseBlocks } from '@/media/tape/wav.ts';
import { tapeBlockInfo } from '@/machines/shared/tape-block-info.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';
import { parseCasBlocks } from '@/machines/msx/msx-tape.ts';

/** Cassette images the MSX recorder plays. */
export const MSX_TAPE_PATTERN = /\.(?:cas|wav|tsx|tzx)$/i;

export class MsxTapeService implements TapeService {
  private _name = '';

  constructor(private readonly m: MsxMachine) {}

  get loaded(): boolean { return this.m.tape.blocks.length > 0; }
  get name(): string { return this._name; }
  get blocks(): readonly TapeBlockInfo[] { return this.m.tape.blocks.map(tapeBlockInfo); }
  get rawBlocks(): readonly TapeBlock[] { return this.m.tape.blocks; }
  get position(): number { return this.m.tape.position; }
  get playing(): boolean { return this.m.tape.playing; }
  get paused(): boolean { return this.m.tape.paused; }

  /** Parse a cassette image into deck blocks. Throws on a damaged or
   *  unknown image (nothing is changed then). */
  private parse(data: Uint8Array, name: string): TapeBlock[] {
    const ext = name.toLowerCase().split('.').pop();
    if (ext === 'wav') return wavToPulseBlocks(data);
    if (ext === 'tsx' || ext === 'tzx') return parseTZX(data);
    const blocks = casToPulseBlocks(data);
    if (blocks.length === 0) throw new Error('No MSX cassette blocks found');
    return blocks;
  }

  private install(blocks: TapeBlock[], data: Uint8Array, name: string): void {
    const deck = this.m.tape;
    deck.stopPlayback();
    deck.blocks = blocks;
    deck.position = 0;
    if (/\.cas$/i.test(name)) this.m.cassette.mount(data, name);
    else this.m.cassette.eject();
    this._name = name;
  }

  /** Mount a cassette with PLAY pressed: the motor relay decides when the
   *  tape moves. Throws when the image cannot be read. */
  mount(data: Uint8Array, name: string): void {
    const blocks = this.parse(data, name);
    this.install(blocks, data, name);
    this.m.tape.paused = false;
    this.m.tape.startPlayback();
  }

  /** Reload-restore path: at the start, paused. */
  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    let blocks: TapeBlock[];
    try { blocks = this.parse(data, name); } catch { return false; }
    this.install(blocks, data, name);
    this.m.tape.paused = true;
    return true;
  }

  stashState(): TapeStashState | null {
    if (!this.loaded) return null;
    return {
      blocks: [...this.m.tape.blocks],
      position: this.m.tape.position,
      paused: this.m.tape.paused,
      casData: this.m.cassette.loaded ? this.m.cassette.getData() : undefined,
    };
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (!state.blocks || state.blocks.length === 0) return;
    const deck = this.m.tape;
    deck.blocks = state.blocks;
    deck.position = state.position ?? 0;
    deck.paused = state.paused ?? true;
    if (state.casData) {
      this.m.cassette.mount(state.casData, name);
      this.m.cassette.seekBlock(deck.position);
    }
    this._name = name;
  }

  play(): void {
    const deck = this.m.tape;
    if (deck.finished) deck.rewind();
    deck.paused = false;
    deck.startPlayback();
  }

  pause(): void { this.m.tape.paused = true; }
  resume(): void { this.m.tape.paused = false; }
  stop(): void { this.m.tape.stopPlayback(); }

  rewind(): void {
    this.m.tape.rewind();
    this.m.cassette.rewind();
  }

  seek(block: number): void {
    const deck = this.m.tape;
    deck.position = Math.max(0, Math.min(block, deck.blocks.length));
    if (deck.playing) deck.startPlayback();
    this.m.cassette.seekBlock(deck.position);
  }

  eject(): void {
    const deck = this.m.tape;
    deck.stopPlayback();
    deck.blocks = [];
    deck.position = 0;
    deck.paused = true;
    this.m.cassette.eject();
    this._name = '';
  }

  /** What the machine has saved through the BIOS (CSAVE/BSAVE"CAS:"/SAVE
   *  "CAS:") since the last reset, as a .cas image. */
  recordedBytes(): { data: Uint8Array; filename: string } | null {
    const data = this.m.cassette.recorded();
    if (!data) return null;
    const first = parseCasBlocks(data).find(b => b.name);
    const stem = (first?.name ?? '').trim().replace(/[^A-Za-z0-9_.-]/g, '_');
    return { data, filename: `${stem || 'msx'}.cas` };
  }
}
