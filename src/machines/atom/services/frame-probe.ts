import type {
  FrameIndicators, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import type { AtomMachine } from '../atom-machine.ts';

class AtomTranscribeDriver implements TranscribeDriver {
  private _active = false;
  constructor(private readonly m: AtomMachine) {}
  get active(): boolean { return this._active; }
  activate(): void { this._active = true; }
  deactivate(): void { this._active = false; }

  run() {
    const m = this.m;
    const result = m.ocrScreenStyled();
    if (result.mask.some(Boolean)) {
      m.blankCells(result.mask);
      if (m.display) m.display.updateTexture(m.pixels);
    }
    return { text: result.text, html: result.html, grid: result.grid, field: m.textField };
  }
}

export class AtomFrameProbe implements FrameProbe {
  readonly transcribe: AtomTranscribeDriver;
  /** The tape moved its level during the last UI frame: light the EAR lamp. */
  private earActive = false;

  constructor(private readonly machine: AtomMachine) {
    this.transcribe = new AtomTranscribeDriver(machine);
  }

  /** The cassette input idles high on the Atom, so the EAR lamp follows level
   *  changes rather than the line's resting state (which would keep it on). */
  frameTick(_out: FrameIndicators): void {
    this.earActive = this.machine.tape.takeEarEdges() > 0;
  }

  /** Pure read — overwrite every channel this machine owns, allocating nothing. */
  sample(out: FrameIndicators): void {
    const tape = this.machine.tape;
    out.keyboard = this.machine.activity.keyboardReads;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = this.earActive ? 1 : 0;
    out.tapeLoad = tape.playing ? 1 : 0;
    out.beeper = this.machine.activity.speakerToggles;
    out.psg = 0;
    out.videoFx = 0;
    out.disk = 0;
    out.tapeTurbo = false;
    out.tapeLoaded = tape.loaded;
    out.tapePlaying = tape.playing;
    out.tapePaused = tape.paused;
    out.tapeFinished = tape.finished;
    out.tapePosition = tape.position;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = this.machine.traceActive;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
  }
}
