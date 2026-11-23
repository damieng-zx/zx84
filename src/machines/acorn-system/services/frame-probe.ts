import type {
  FrameIndicators, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { fixedDrive } from '@/media/floppy/floppy-sound.ts';
import type { AcornSystemMachine } from '../machine.ts';

/** Acorn's standard 5.25" drive, for the drive-sound feed. */
const DRIVE = fixedDrive('5.25inch');

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

/**
 * The System's dashboard: the KEY indicator shows the COS/DOS polling the
 * keyboard port, the TAPE indicators report the CUTS transport, and a System 3
 * adds the two drives' activity and head positions. There is no sound.
 *
 * The BASIC panes' bodies live in `inspect.ts` (on demand, may allocate).
 */
export class AcornSystemFrameProbe implements FrameProbe {
  readonly transcribe: AcornSystemTranscribeDriver;

  constructor(private readonly machine: AcornSystemMachine) {
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

    const fdc = this.machine.disk;
    out.disk = fdc && fdc.motorOn ? (fdc.isExecuting ? 2 : 1) : 0;
    const active = fdc ? fdc.currentDrive : -1;
    for (let unit = 0; unit < 2; unit++) {
      if (!fdc || !fdc.motorOn || unit !== active) out.driveLed[unit] = 0;
      else out.driveLed[unit] = fdc.isExecuting ? (fdc.isWriting ? 3 : 2) : 1;
      out.driveTrack[unit] = fdc ? fdc.getUnitTrack(unit) : 0;
      out.driveSector[unit] = fdc && fdc.isExecuting && unit === active ? fdc.currentSector : -1;
      out.driveDirty[unit] = fdc && fdc.isDirty(unit) ? 1 : 0;
    }
    out.driveLed[2] = out.driveLed[3] = -1;
    out.floppySlot = active >= 0 && active < 2 ? active : -1;
    out.floppyMotor = fdc ? fdc.motorOn : false;
    out.floppyTrack = fdc ? fdc.getUnitTrack(active) : 0;
    out.floppyProfile = DRIVE();
  }

  /** The disc in a Drive-pane slot (post-format refresh). */
  diskImageForSlot(slot: number): DskImage | null {
    return slot < 2 ? this.machine.disk?.getDiskImage(slot) ?? null : null;
  }
}
