import type { FrameIndicators, FrameProbe, TranscribeDriver } from '@/machines/machine.ts';
import type { Apple1Machine } from '../apple1-machine.ts';

class Apple1TranscribeDriver implements TranscribeDriver {
  private _active = false;
  constructor(private readonly m: Apple1Machine) {}
  get active(): boolean { return this._active; }
  activate(): void { this._active = true; }
  deactivate(): void { this._active = false; }

  run() {
    const m = this.m;
    const result = m.ocrScreenStyled();
    m.blankCells(result.mask);
    if (m.display) m.display.updateTexture(m.pixels);
    return { text: result.text, html: result.html, grid: result.grid, field: m.textField };
  }
}

export class Apple1FrameProbe implements FrameProbe {
  readonly transcribe: Apple1TranscribeDriver;

  constructor(private readonly machine: Apple1Machine) {
    this.transcribe = new Apple1TranscribeDriver(machine);
  }

  /** Pure read — overwrite every channel this machine owns, allocating nothing.
   *  The KEY LED shows the program polling the keyboard, not a key being held. */
  sample(out: FrameIndicators): void {
    out.keyboard = this.machine.activity.kbdReads;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = 0;
    out.tapeLoad = 0;
    out.beeper = 0;
    out.psg = 0;
    out.videoFx = 0;
    out.disk = 0;
    out.tapeTurbo = false;
    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = true;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = false;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
  }
}
