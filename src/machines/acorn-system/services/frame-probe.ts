import type {
  FrameIndicators, FramePaneProvider, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import { systemBasicListing, systemBasicVariables } from '../basic.ts';
import type { AcornSystemMachine } from '../machine.ts';

class AcornSystemTranscribeDriver implements TranscribeDriver {
  private _active = false;
  constructor(private readonly m: AcornSystemMachine) {}
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

/** The BASIC panes' pull-on-demand bodies (read only when the pane is open). */
class AcornSystemPanes implements FramePaneProvider {
  constructor(private readonly m: AcornSystemMachine) {}

  basicListing() { return systemBasicListing(this.m.memory); }
  basicVars() { return systemBasicVariables(this.m.memory); }
}

/**
 * The System 2's dashboard: the KEY indicator shows the COS polling the
 * keyboard port, and the TAPE indicators report the CUTS transport. The
 * machine has no disc and no sound.
 */
export class AcornSystemFrameProbe implements FrameProbe {
  readonly panes: AcornSystemPanes;
  readonly transcribe: AcornSystemTranscribeDriver;

  constructor(private readonly machine: AcornSystemMachine) {
    this.panes = new AcornSystemPanes(machine);
    this.transcribe = new AcornSystemTranscribeDriver(machine);
  }

  sample(out: FrameIndicators): void {
    const cassette = this.machine.cassette;
    out.keyboard = this.machine.activity.kbdReads;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = cassette.fsk.level;
    out.tapeLoad = 0;
    out.beeper = 0;
    out.psg = 0;
    out.videoFx = 0;
    out.disk = 0;
    out.tapeTurbo = cassette.turboActive;
    out.tapeLoaded = cassette.loaded;
    out.tapePlaying = cassette.deck.playing;
    out.tapePaused = cassette.userPaused;
    out.tapeFinished = cassette.deck.finished;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = this.machine.traceActive;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
  }
}
