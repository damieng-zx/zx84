/**
 * NewBrain TapeService — cassette transport over the shared pulse-level
 * TapeDeck. The COP420's relays decide when the tape actually moves (see
 * `NewBrainMachine.relaysChanged`), so play here only arms the deck: the OS
 * starts and stops the motor itself, like the REM socket on a real recorder.
 */

import type { TapeBlockInfo, TapeService, TapeStashState } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { parseCSW } from '@/media/tape/csw.ts';
import { wavToPulseBlocks } from '@/media/tape/wav.ts';
import { pulsesToWav } from '@/media/tape/wav-writer.ts';
import { tapeBlockInfo } from '@/machines/shared/tape-block-info.ts';
import type { NewBrainMachine } from '../newbrain-machine.ts';
import { NB_CPU_CLOCK } from '../constants.ts';

/** Fewer toggles of the tape-out line than this is a stray write, not a SAVE:
 *  a recording opens with a leader of thousands. */
const MIN_RECORDED_EDGES = 256;
/** Longest silence kept between two recordings, in seconds. */
const MAX_GAP_SECONDS = 1;

export class NewBrainTapeService implements TapeService {
  private _name = '';

  constructor(private readonly m: NewBrainMachine) {}

  get loaded(): boolean { return this.m.tape.blocks.length > 0; }
  get name(): string { return this._name; }
  get blocks(): readonly TapeBlockInfo[] { return this.m.tape.blocks.map(tapeBlockInfo); }
  get rawBlocks(): readonly TapeBlock[] { return this.m.tape.blocks; }
  get position(): number { return this.m.tape.position; }
  get playing(): boolean { return this.m.tape.playing; }
  get paused(): boolean { return this.m.tape.paused; }

  /** Put a parsed tape on the deck at its start, running but held until the
   *  OS switches a motor relay on. */
  mountBlocks(blocks: TapeBlock[], name: string): void {
    this.m.tape.blocks = blocks;
    this.m.tape.position = 0;
    this.m.tape.paused = true;
    this.m.tapeUserPaused = false;
    this.m.tape.startPlayback();
    this._name = name;
  }

  play(): void {
    this.m.tapeUserPaused = false;
    this.m.tape.startPlayback();
    this.m.tape.paused = true;   // moves when the OS runs a motor
  }

  pause(): void {
    this.m.tapeUserPaused = true;
    this.m.tape.paused = true;
  }

  resume(): void {
    this.m.tapeUserPaused = false;
    this.m.tape.paused = !(this.m.board.motor1 || this.m.board.motor2);
  }

  stop(): void {
    this.m.tapeUserPaused = true;
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

  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    let blocks: TapeBlock[];
    try {
      blocks = name.toLowerCase().endsWith('.csw') ? await parseCSW(data) : wavToPulseBlocks(data);
    } catch {
      return false;
    }
    this.m.tape.blocks = blocks;
    this.m.tape.position = 0;
    this.m.tape.paused = true;
    this._name = name;
    return true;
  }

  /** What the machine has SAVEd since the last reset, as a WAV square wave
   *  rebuilt from the COP's tape-out timing, or null when nothing has been
   *  written. The ROM and the COP firmware do the whole of the encoding, so
   *  this is whatever they actually put on the line. */
  recordedBytes(): { data: Uint8Array; filename: string } | null {
    const rec = this.m.tapeRecorder;
    if (rec.count < MIN_RECORDED_EDGES) return null;
    const pulses = rec.pulses(this.m.cpu.tStates);
    const maxGap = NB_CPU_CLOCK * MAX_GAP_SECONDS;
    for (let i = 0; i < pulses.length; i++) if (pulses[i] > maxGap) pulses[i] = maxGap;
    return { data: pulsesToWav(pulses, NB_CPU_CLOCK, rec.firstLevel), filename: 'newbrain-tape.wav' };
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
