/**
 * ZX80/ZX81 TapeService — only the recording half.
 *
 * These machines have no pulse deck: their ROM LOAD and SAVE routines are
 * trapped and move the program image directly (see Zx8xMachine.
 * serviceTapeTrap and tape-shelf.ts), and programs are mounted through the
 * media service, not a tape transport. So the transport here is inert —
 * nothing is ever "loaded" on it — and the service exists for
 * `recordedBytes`: the most recent SAVE, as the same image the LOAD trap
 * reads back (.p on the ZX81, .o on the ZX80).
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import type { Zx8xMachine } from '../zx8x-machine.ts';

/** Characters a host filename cannot carry (ZX81 names may contain '"', '/',
 *  '*', '?', ':', '<', '>'). */
const UNSAFE_FILENAME = /[\/:*?"<>|]/g;

export class Zx8xTapeService implements TapeService {
  constructor(private readonly machine: Zx8xMachine) {}

  readonly loaded = false;
  readonly name = '';
  readonly blocks: readonly TapeBlockInfo[] = [];
  readonly rawBlocks: readonly TapeBlock[] = [];
  readonly position = 0;
  readonly playing = false;
  readonly paused = true;

  /** Programs are mounted through the media service; there is no tape to
   *  restore here. */
  async mountBytes(_data: Uint8Array, _name: string): Promise<boolean> { return false; }
  stashState(): TapeStashState | null { return null; }
  restoreStash(_state: TapeStashState, _name: string): void {}
  play(): void {}
  pause(): void {}
  resume(): void {}
  stop(): void {}
  rewind(): void {}
  seek(_block: number): void {}
  eject(): void {}

  /** The most recent SAVE since reset: a ZX81 `.p` (VERSN up to E_LINE)
   *  named after the program, or a ZX80 `.o` ($4000 up to E_LINE). */
  recordedBytes(): { data: Uint8Array; filename: string } | null {
    const saved = this.machine.lastSave;
    if (!saved) return null;
    if (this.machine.model === 'zx80') return { data: saved.data.slice(), filename: 'zx80.o' };
    const base = saved.name.replace(UNSAFE_FILENAME, '_').trim();
    return { data: saved.data.slice(), filename: `${base || 'zx81'}.p` };
  }
}
