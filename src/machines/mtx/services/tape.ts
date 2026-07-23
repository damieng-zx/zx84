import type {
  TapeBlockInfo, TapeService, TapeStashState,
} from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { parseMtxTapeHeader } from '@/media/tape/mtx.ts';
import type { MtxMachine } from '../mtx-machine.ts';

/** Instant logical-cassette service for emulator-standard `.mtx` streams. */
export class MtxTapeService implements TapeService {
  constructor(private readonly machine: MtxMachine) {}

  get loaded(): boolean { return this.machine.cassette.loaded; }
  get name(): string { return this.machine.cassette.name; }
  get blocks(): readonly TapeBlockInfo[] {
    const data = this.machine.cassette.getData();
    const header = parseMtxTapeHeader(data);
    if (!header) return [];
    return [{
      index: 0,
      label: header.name ? `MTX "${header.name}"` : 'MTX program',
      detail: `${data.length} bytes`,
      kind: 'program',
      name: header.name,
      type: 'MTX',
      size: data.length,
    }];
  }
  get rawBlocks(): readonly TapeBlock[] { return []; }
  get position(): number { return this.machine.cassette.currentBlock(); }
  get playing(): boolean { return false; }
  get paused(): boolean { return true; }

  mount(data: Uint8Array, name: string): boolean {
    if (!parseMtxTapeHeader(data)) return false;
    this.machine.cassette.mount(data, name);
    return true;
  }

  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    return this.mount(data, name);
  }

  stashState(): TapeStashState | null {
    return this.loaded ? { casData: this.machine.cassette.getData() } : null;
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (state.casData) this.mount(state.casData, name);
  }

  play(): void {}
  pause(): void {}
  resume(): void {}
  stop(): void {}
  rewind(): void { this.machine.cassette.rewind(); }
  seek(_block: number): void {}
  eject(): void { this.machine.cassette.eject(); }
}
