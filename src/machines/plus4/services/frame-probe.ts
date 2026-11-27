/**
 * Plus4FrameProbe — the status bar's and Memory pane's view of the Plus/4.
 */

import type {
  FrameIndicators, FrameProbe,
} from '@/machines/machine.ts';
import type { Plus4Machine } from '../plus4-machine.ts';
import { sampleCbmDrives } from '@/machines/shared/cbm/drive-services.ts';
import { CbmTranscribeDriver } from '@/machines/shared/cbm/frame-probe.ts';

/** TEXT overlay: read the character screen, then blank what it read. */
class Plus4TranscribeDriver extends CbmTranscribeDriver {
  constructor(m: Plus4Machine) { super(m); }
}

export class Plus4FrameProbe implements FrameProbe {
  readonly transcribe: Plus4TranscribeDriver;

  constructor(private readonly m: Plus4Machine) {
    this.transcribe = new Plus4TranscribeDriver(m);
  }

  sample(out: FrameIndicators): void {
    const m = this.m;
    out.keyboard = m.activity.kbdReads;
    out.joystick = m.activity.joyReads;
    out.mouse = 0;
    out.tapeIn = m.activity.tapeEdges;
    out.tapeLoad = m.activity.tapeEdges;
    out.beeper = 0;
    out.psg = m.activity.soundWrites;
    out.videoFx = 0;
    const tape = m.tape;
    out.tapeTurbo = m.tapeTurboActive;
    out.tapeLoaded = tape.blocks.length > 0;
    out.tapePlaying = tape.playing && !tape.paused;
    out.tapePaused = tape.paused;
    out.tapeFinished = tape.finished;
    out.tapePosition = tape.position;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = m.traceActive;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    sampleCbmDrives(out, m.drives);
  }
}
