import { AudioCassetteTapeService } from '@/machines/shared/audio-cassette-tape-service.ts';
import { pulsesToWav } from '@/media/tape/wav-writer.ts';
import type { Apple1Machine } from '../apple1-machine.ts';
import { APPLE1_CPU_CLOCK } from '../constants.ts';

/** Fewer output toggles than this is a stray access or two, not a recording:
 *  the ACI ROM's write opens with a leader of thousands of toggles. */
const MIN_RECORDED_EDGES = 256;

/** Longest silence kept between recordings, in seconds: the time between two
 *  writes (or since the last one) is not worth minutes of empty audio. */
const MAX_GAP_SECONDS = 1;

/** Cassette transport for the Apple Cassette Interface (comparator on `$C081`). */
export class Apple1TapeService extends AudioCassetteTapeService {
  constructor(private readonly m: Apple1Machine) { super(m); }

  /** What the interface has written to tape since the last reset, as a WAV
   *  square wave rebuilt from the output's toggle timing, or null when the
   *  output has hardly moved. Every access to the ACI's I/O page toggles the
   *  output — reads of the input at `$C081` included, exactly as on the real
   *  card — so reading a tape also leaves a recording behind. */
  recordedBytes(): { data: Uint8Array; filename: string } | null {
    const rec = this.m.tapeRecorder;
    if (rec.count < MIN_RECORDED_EDGES) return null;
    const pulses = rec.pulses(this.m.tapeClock);
    const maxGap = APPLE1_CPU_CLOCK * MAX_GAP_SECONDS;
    for (let i = 0; i < pulses.length; i++) if (pulses[i] > maxGap) pulses[i] = maxGap;
    return { data: pulsesToWav(pulses, APPLE1_CPU_CLOCK, rec.firstLevel), filename: 'apple1-tape.wav' };
  }
}
