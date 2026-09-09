/**
 * LynxTapeService — the cassette transport over the shared pulse deck.
 *
 * The Lynx wires its motor relay to port 0x80, so unlike the CPC there is
 * nothing to infer: the machine starts and stops the deck when the ROM spins
 * the motor, and play/pause here are plain transport controls on top.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { tapeBlockInfo } from '@/machines/shared/tape-block-info.ts';
import {
  LYNX_TAPE_HZ_128, LYNX_TAPE_HZ_48, parseLynxTap, type LynxTapEntry,
} from '@/media/tape/lynx-tap.ts';
import type { LynxMachine } from '../lynx-machine.ts';

export class LynxTapeService implements TapeService {
  private _name = '';
  private _entries: readonly LynxTapEntry[] = [];

  constructor(private readonly m: LynxMachine) {}

  get loaded(): boolean { return this.m.tape.blocks.length > 0; }
  get name(): string { return this._name; }
  get blocks(): readonly TapeBlockInfo[] { return this.m.tape.blocks.map(tapeBlockInfo); }
  get rawBlocks(): readonly TapeBlock[] { return this.m.tape.blocks; }
  get position(): number { return this.m.tape.position; }
  get playing(): boolean { return this.m.tape.playing; }
  get paused(): boolean { return this.m.tape.paused; }

  /** What is on the mounted tape, for the mount message and the tape pane. */
  get entries(): readonly LynxTapEntry[] { return this._entries; }

  /** The tape rate this board records at — the 128K runs at twice the speed. */
  private get sampleHz(): number {
    return this.m.memory.is128k ? LYNX_TAPE_HZ_128 : LYNX_TAPE_HZ_48;
  }

  /**
   * Mount a .tap. It sits paused at the start: the ROM releases it by spinning
   * the motor, which is what a real deck does under a LOAD.
   */
  mount(data: Uint8Array, name: string): boolean {
    const tape = parseLynxTap(data, this.sampleHz);
    if (tape.blocks.length === 0) return false;
    this.m.tape.blocks = tape.blocks;
    this.m.tape.position = 0;
    this.m.tape.paused = true;
    this.m.tape.startPlayback();
    this._entries = tape.entries;
    this._name = name;
    return true;
  }

  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    try {
      return this.mount(data, name);
    } catch {
      return false;
    }
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
    this.m.tape.stopPlayback();
    this.m.tape.blocks = [];
    this.m.tape.position = 0;
    this.m.tape.paused = true;
    this._entries = [];
    this._name = '';
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
