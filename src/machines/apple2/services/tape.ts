import { AudioCassetteTapeService } from '@/machines/shared/audio-cassette-tape-service.ts';
import { pulsesToWav } from '@/media/tape/wav-writer.ts';
import type { Apple2Machine } from '../apple2-machine.ts';
import { APPLE2_CPU_CLOCK } from '../constants.ts';

/** Fewer $C020 toggles than this is a stray access or two, not a recording:
 *  the Monitor's WRITE opens with a 10-second 770 Hz header tone alone
 *  (~15,000 toggles). */
const MIN_RECORDED_EDGES = 256;

/** Longest silence kept between recordings, in seconds: the time between two
 *  saves (or since the last one) is not worth minutes of empty audio. */
const MAX_GAP_SECONDS = 1;

/** Cassette transport for the Apple II's audio tape port (comparator on $C060). */
export class Apple2TapeService extends AudioCassetteTapeService {
  constructor(private readonly m: Apple2Machine) { super(m); }

  /** What the machine has written to $C020 since the last reset, as a WAV
   *  square wave rebuilt from the toggle timing — the Monitor's `W` command,
   *  Applesoft's `SAVE`, or a program's own tape writer — or null when the
   *  output has hardly moved. */
  recordedBytes(): { data: Uint8Array; filename: string } | null {
    const rec = this.m.tapeRecorder;
    if (rec.count < MIN_RECORDED_EDGES) return null;
    const pulses = rec.pulses(this.m.tapeClock);
    const maxGap = APPLE2_CPU_CLOCK * MAX_GAP_SECONDS;
    for (let i = 0; i < pulses.length; i++) if (pulses[i] > maxGap) pulses[i] = maxGap;
    return { data: pulsesToWav(pulses, APPLE2_CPU_CLOCK, rec.firstLevel), filename: 'apple2-tape.wav' };
  }
}
