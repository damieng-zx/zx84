/**
 * SAM TapeService — cassette transport over the shared pulse-level TapeDeck.
 *
 * The SAM's cassette port is Spectrum-shaped: pulses arrive on the EAR bit of
 * port 0xFE (bit 6) and MIC goes out on bit 3. SimCoupe reads the same image
 * formats through libspectrum — TAP, TZX, CSW and WAV — and converts their
 * 3.5 MHz-referenced pulse lengths to SAM T-states, which is exactly what
 * `TapeDeck.pulseScale` does here.
 *
 * There is no motor relay to gate on, so unlike the CPC the deck is driven
 * purely by the machine's own advance (see `SamMachine.advanceTapeTo`) and a
 * user stop/pause is a plain deck operation.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { parseCSW } from '@/media/tape/csw.ts';
import { tapeBlockInfo } from '@/machines/shared/tape-block-info.ts';
import type { SamMachine } from '../sam-machine.ts';

export class SamTapeService implements TapeService {
  /** Mounted filename — media identity is service state; the deck holds only
   *  the parsed blocks. */
  private _name = '';

  constructor(private readonly m: SamMachine) {}

  get loaded(): boolean { return this.m.tape.blocks.length > 0; }
  get name(): string { return this._name; }
  get blocks(): readonly TapeBlockInfo[] { return this.m.tape.blocks.map(tapeBlockInfo); }
  get rawBlocks(): readonly TapeBlock[] { return this.m.tape.blocks; }
  get position(): number { return this.m.tape.position; }
  get playing(): boolean { return this.m.tape.playing; }
  get paused(): boolean { return this.m.tape.paused; }

  /** Put a parsed tape on the deck: positioned at the start, playing but with
   *  pause held, so the ROM's loader releases it when it pulls on the tape. */
  mountBlocks(blocks: TapeBlock[], name: string): void {
    const t = this.m.tape;
    t.blocks = blocks;
    t.position = 0;
    t.paused = true;
    t.startPlayback();
    this._name = name;
  }

  play(): void {
    this.m.tape.paused = false;
    this.m.tape.startPlayback();
  }

  pause(): void { this.m.tape.paused = true; }
  resume(): void { this.m.tape.paused = false; }
  stop(): void { this.m.tape.stopPlayback(); }
  rewind(): void { this.m.tape.rewind(); }
  seek(block: number): void { this.m.tape.position = block; }

  eject(): void {
    const t = this.m.tape;
    t.stopPlayback();
    t.blocks = [];
    t.position = 0;
    t.paused = true;
    this._name = '';
  }

  /** Parse and mount persisted tape bytes at the start, paused and not
   *  playing — the reload-restore path. */
  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    let blocks: TapeBlock[];
    try {
      const ext = name.toLowerCase().split('.').pop();
      blocks = ext === 'tzx' ? parseTZX(data)
        : ext === 'csw' ? await parseCSW(data)
        : this.m.tape.parseTAP(data);
    } catch {
      return false;
    }
    if (blocks.length === 0) return false;
    this.m.tape.blocks = blocks;
    this.m.tape.position = 0;
    this.m.tape.paused = true;
    this._name = name;
    return true;
  }

  stashState(): TapeStashState | null {
    if (this.m.tape.blocks.length === 0) return null;
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
