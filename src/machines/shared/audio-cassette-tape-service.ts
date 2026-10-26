import type {
  TapeBlockInfo, TapeService, TapeStashState,
} from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import type { AudioCassette } from './audio-cassette.ts';

/**
 * Cassette transport for an audio tape port (Apple I, Apple II).
 *
 * There are no blocks to seek: the tape is a WAV recording of the audio, and the
 * machine reads the comparator output on its input bit while the ROM times the
 * gaps itself. So the transport is a single logical block with
 * play/pause/stop/rewind over the recording.
 */
export class AudioCassetteTapeService implements TapeService {
  private raw: Uint8Array | null = null;

  constructor(private readonly machine: { readonly cassette: AudioCassette }) {}

  get loaded(): boolean { return this.machine.cassette.loaded; }
  get name(): string { return this.machine.cassette.name; }

  get blocks(): readonly TapeBlockInfo[] {
    if (!this.loaded) return [];
    return [{
      index: 0,
      label: this.machine.cassette.name || 'Cassette audio',
      detail: 'audio recording',
      kind: 'audio',
    }];
  }

  get rawBlocks(): readonly TapeBlock[] { return []; }
  get position(): number { return this.loaded ? 0 : -1; }
  get playing(): boolean { return this.machine.cassette.playing; }
  get paused(): boolean { return !this.machine.cassette.playing; }

  /** Mount a WAVE recording (the media service's path). */
  mountWav(data: Uint8Array, name: string): boolean {
    if (!this.machine.cassette.mountWav(data, name)) return false;
    this.raw = data.slice();
    return true;
  }

  async mountBytes(data: Uint8Array, name: string): Promise<boolean> {
    return this.mountWav(data, name);
  }

  play(): void {
    if (this.machine.cassette.finished) this.machine.cassette.rewind();
    this.machine.cassette.playing = true;
  }

  pause(): void { this.machine.cassette.playing = false; }

  resume(): void { this.machine.cassette.playing = true; }

  stop(): void { this.machine.cassette.playing = false; }

  rewind(): void { this.machine.cassette.rewind(); }

  seek(_block: number): void {}

  eject(): void {
    this.machine.cassette.eject();
    this.raw = null;
  }

  stashState(): TapeStashState | null {
    return this.raw ? { casData: this.raw } : null;
  }

  restoreStash(state: TapeStashState, name: string): void {
    if (state.casData) this.mountWav(state.casData, name);
  }
}
