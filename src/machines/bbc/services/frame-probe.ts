import type {
  FrameIndicators, FrameProbe, FramePaneProvider, TranscribeDriver,
} from '@/machines/machine.ts';
import { fixedDrive } from '@/media/floppy/floppy-sound.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { parseBbcBasic, parseBbcBasicVariables } from '@/basic/bbc-basic-parser.ts';
import type { BbcMachine } from '../bbc-machine.ts';

/** BBC DFS drives are 5.25" 40/80-track units (Acorn's standard upgrade). */
const DRIVE = fixedDrive('5.25inch');

class BbcTranscribeDriver implements TranscribeDriver {
  constructor(private readonly m: BbcMachine) {}
  get active(): boolean { return this.m.screenText.active; }
  activate(): void { this.m.screenText.activate(); }
  deactivate(): void { this.m.screenText.deactivate(); }
  run() {
    const m = this.m;
    const result = m.ocrScreenStyled();
    if (result.mask.length > 0) {
      m.blankCells(result.mask, result.cols, result.rows, result.paper);
      if (m.display) m.display.updateTexture(m.pixels);
    }
    // The grid fills the mode's text window (Mode 7's centred teletext box,
    // or the bitmap modes' rows), not the whole bordered buffer, so the
    // overlay is anchored to that box.
    const g = m.textLayout();
    return {
      text: result.text, html: result.html, grid: result.grid,
      field: { x: g.x, y: g.y, width: g.cols * g.cellW, height: g.rows * g.cellH },
    };
  }
}

export class BbcFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;
  readonly transcribe: BbcTranscribeDriver;

  constructor(private readonly machine: BbcMachine) {
    this.transcribe = new BbcTranscribeDriver(machine);
    this.panes = {
      // The tokenised BBC BASIC program lives in main RAM from PAGE.
      basicListing: () => parseBbcBasic(machine.memory.ram),
      // Variables live in the heap above TOP plus the resident A%-Z%.
      basicVars: () => parseBbcBasicVariables(machine.memory.ram),
    };
  }

  /** Pure read — overwrite every channel this machine owns so no stale value
   *  from a previous frame leaks through. Allocates nothing. */
  sample(out: FrameIndicators): void {
    out.keyboard = 0;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = 0;
    out.tapeLoad = 0;
    out.beeper = 0;
    out.psg = this.machine.activity.psgWrites;
    out.videoFx = 0;
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

    const fdc = this.machine.disc;
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

  frameTick(out: FrameIndicators): void {
    const fdc = this.machine.disc;
    if (fdc && fdc.formattedUnit >= 0) {
      out.formattedSlot = fdc.formattedUnit;
      fdc.formattedUnit = -1;
    }
  }

  diskImageForSlot(slot: number): DskImage | null {
    return slot < 2 ? this.machine.disc?.getDiskImage(slot) ?? null : null;
  }
}
