/**
 * Atari TapeService — the 410/1010 program recorder (see `cassette.ts`). The
 * computer runs the tape through the recorder's motor line, as the real one
 * does with PLAY held down, so play/pause/stop are inert and the pane
 * highlights the file the tape is at.
 *
 * The tape is listed by *file* (the records up to each EOF record) rather
 * than by record, since a single program is often a few hundred records.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import type { AtariMachine } from '../atari-machine.ts';

export class AtariTapeService implements TapeService {
  constructor(private readonly m: AtariMachine) {}

  get loaded(): boolean { return this.m.cassette.loaded; }
  get name(): string { return this.m.cassette.name; }
  get blocks(): readonly TapeBlockInfo[] {
    return this.m.cassette.fileList.map((f, index) => ({
      index,
      label: `File ${index + 1}`,
      kind: 'data',
      detail: `${f.records} record${f.records === 1 ? '' : 's'} · ${f.bytes} bytes${f.unterminated ? ' · no EOF' : ''}`,
      size: f.bytes,
    }));
  }
  /** No pulse deck: the block view flows through the cas signals instead. */
  get rawBlocks(): readonly TapeBlock[] { return []; }
  get position(): number { return Math.max(0, this.m.cassette.currentFile()); }
  get playing(): boolean { return false; }
  get paused(): boolean { return true; }

  /** Mount a `.cas` image, rewound. */
  mount(data: Uint8Array, name: string): boolean { return this.m.cassette.mount(data, name); }

  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    return this.m.cassette.mount(data, name);
  }

  stashState(): TapeStashState | null {
    const data = this.m.cassette.getData();
    return data ? { casData: data } : null;
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (state.casData) this.m.cassette.mount(state.casData, name);
  }

  // The motor line, not the user, starts and stops the tape.
  play(): void {}
  pause(): void {}
  resume(): void {}
  stop(): void {}
  rewind(): void { this.m.cassette.rewind(); }
  seek(_block: number): void {}

  eject(): void { this.m.cassette.eject(); }

  /** What the machine has saved to cassette since the last reset. */
  recordedBytes(): { data: Uint8Array; filename: string } | null {
    const data = this.m.cassette.recorded();
    return data ? { data, filename: 'atari.cas' } : null;
  }
}
