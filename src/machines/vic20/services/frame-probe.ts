/**
 * Vic20FrameProbe — the status bar's view of the VIC-20. The Memory pane's
 * layout and the BASIC panes live in `inspect.ts` (on demand, may allocate).
 */

import type {
  FrameIndicators, FrameProbe,
} from '@/machines/machine.ts';
import type { Vic20Machine } from '../vic20-machine.ts';
import { sampleCbmDrives } from '@/machines/shared/cbm/drive-services.ts';
import { CbmTranscribeDriver } from '@/machines/shared/cbm/frame-probe.ts';

/** TEXT overlay: read the character screen, then blank what it read. */
class Vic20TranscribeDriver extends CbmTranscribeDriver {
  constructor(m: Vic20Machine) { super(m); }
}

export class Vic20FrameProbe implements FrameProbe {
  readonly transcribe: Vic20TranscribeDriver;

  constructor(private readonly m: Vic20Machine) {
    this.transcribe = new Vic20TranscribeDriver(m);
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
