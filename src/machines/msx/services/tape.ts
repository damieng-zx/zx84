/**
 * MSX TapeService — cassette transport over the instant-load MsxCassette (.cas
 * byte stream, served through the BIOS TAPION/TAPIN traps). There is no
 * pulse-level transport: play/pause/stop are inert, the BIOS drives the reads.
 *
 * This unifies the MSX under the same TapeService surface the pulse-deck machines
 * use, so the tape pane and eject/save paths stay machine-blind. The .cas block
 * listing is surfaced as generic TapeBlockInfo.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';
import { parseCasBlocks } from '@/machines/msx/msx-tape.ts';

export class MsxTapeService implements TapeService {
  constructor(private readonly m: MsxMachine) {}

  get loaded(): boolean { return this.m.cassette.loaded; }
  get name(): string { return this.m.cassette.name; }
  get blocks(): readonly TapeBlockInfo[] {
    return parseCasBlocks(this.m.cassette.getData()).map((b, index) => ({
      index,
      label: b.title,
      kind: b.header ? 'header' : 'data',
    }));
  }
  /** No pulse deck: the block view flows through the cas signals instead. */
  get rawBlocks(): readonly TapeBlock[] { return []; }
  get position(): number { return this.m.cassette.currentBlock(); }
  get playing(): boolean { return false; }
  get paused(): boolean { return true; }

  /** Mount a `.cas` image and rewind to the start. */
  mount(data: Uint8Array, name: string): void { this.m.cassette.mount(data, name); }

  /** Reload-restore path — same instant mount. */
  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    this.m.cassette.mount(data, name);
    return true;
  }

  stashState(): TapeStashState | null {
    return this.m.cassette.loaded ? { casData: this.m.cassette.getData() } : null;
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (state.casData) this.m.cassette.mount(state.casData, name);
  }

  // Instant-load cassette: the BIOS load traps pull bytes on CLOAD/BLOAD, so
  // there is no transport to start, stop or seek.
  play(): void {}
  pause(): void {}
  resume(): void {}
  stop(): void {}
  rewind(): void { this.m.cassette.rewind(); }
  seek(_block: number): void {}

  eject(): void { this.m.cassette.eject(); }
}
