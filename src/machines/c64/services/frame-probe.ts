/**
 * C64FrameProbe - the status bar's view of the 64: activity counters, tape
 * transport and drive telemetry. The Memory pane's banking view and the BASIC
 * panes live in inspect.ts (on demand, may allocate).
 */

import type {
  FrameIndicators, FrameProbe,
} from '@/machines/machine.ts';
import type { C64Machine } from '../c64-machine.ts';
import { sampleCbmDrives } from '@/machines/shared/cbm/drive-services.ts';
import { CbmTranscribeDriver } from '@/machines/shared/cbm/frame-probe.ts';

/** TEXT overlay: read the character screen, then blank what it read. */
class C64TranscribeDriver extends CbmTranscribeDriver {
  constructor(m: C64Machine) { super(m); }
}

export class C64FrameProbe implements FrameProbe {
  readonly transcribe: C64TranscribeDriver;

  constructor(private readonly m: C64Machine) {
    this.transcribe = new C64TranscribeDriver(m);
  }

  sample(out: FrameIndicators): void {
    const m = this.m;
    out.keyboard = m.activity.kbdReads;
    out.joystick = m.activity.joyReads;
    out.mouse = 0;
    out.tapeIn = m.activity.tapeEdges;
    out.tapeLoad = m.activity.tapeEdges;
    out.beeper = 0;
    out.psg = m.activity.sidWrites;
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
