/**
 * CPC TapeService — cassette transport over the shared pulse-level TapeDeck.
 *
 * Unlike the Spectrum there is no loader-detector interplay: the CPC gates tape
 * advance on the firmware's Port-B read cadence (see CpcMachine.advanceTapeTo),
 * so a user stop/pause is a plain deck operation.
 */

import type { TapeBlockInfo, TapeService } from '@/machines/machine.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { tapeBlockInfo } from '@/machines/shared/tape-block-info.ts';

export class CpcTapeService implements TapeService {
  /** Mounted filename — media identity is service state; the deck only holds
   *  blocks. Set by MediaService on mount, cleared on eject. */
  private _name = '';

  constructor(private readonly c: CpcMachine) {}

  get loaded(): boolean { return this.c.tape.blocks.length > 0; }
  get name(): string { return this._name; }
  get blocks(): readonly TapeBlockInfo[] { return this.c.tape.blocks.map(tapeBlockInfo); }
  get position(): number { return this.c.tape.position; }
  get playing(): boolean { return this.c.tape.playing; }
  get paused(): boolean { return this.c.tape.paused; }

  /** Put a parsed tape on the deck: positioned at the start, motor running but
   *  pause held — the firmware releases it once it starts pulling on the tape. */
  mountBlocks(blocks: TapeBlock[], name: string): void {
    this.c.tape.blocks = blocks;
    this.c.tape.position = 0;
    this.c.tape.paused = true;
    this.c.tape.startPlayback();
    this._name = name;
  }

  play(): void {
    this.c.tape.paused = false;
    this.c.tape.startPlayback();
  }

  pause(): void { this.c.tape.paused = true; }

  resume(): void { this.c.tape.paused = false; }

  stop(): void { this.c.tape.stopPlayback(); }

  rewind(): void { this.c.tape.rewind(); }

  seek(block: number): void { this.c.tape.position = block; }

  eject(): void {
    this.c.tape.stopPlayback();
    this.c.tape.blocks = [];
    this.c.tape.position = 0;
    this.c.tape.paused = true;
    this._name = '';
  }
}
