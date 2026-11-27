import type {
  FrameIndicators, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import { fixedDrive } from '@/media/floppy/floppy-sound.ts';
import type { MtxMachine } from '../mtx-machine.ts';

/** The FDX's drives are 5.25" half-height units, fixed: an 80-track FDX image
 *  is well past the capacity where the +3/CPC test would call a drive 3.5". */
const DRIVE = fixedDrive('5.25inch');

/** TEXT-overlay driver: OCRs the VDP screen, blanks the matched cells, and
 *  returns the crisp text/HTML. The FDX 80-column board already renders sharp
 *  text, so nothing is transcribed while it is showing. */
class MtxTranscribeDriver implements TranscribeDriver {
  constructor(private readonly m: MtxMachine) {}
  get active(): boolean { return this.m.screenText.active; }
  activate(): void { this.m.screenText.activate(); }
  deactivate(): void { this.m.screenText.deactivate(); }
  run(): { text: string; html: string; grid: OcrGridName } {
    const m = this.m;
    if (m.column80.enabled) return { text: '', html: '', grid: '32x24' };
    const result = m.ocrScreenStyled();
    if (result.mask.length > 0) {
      m.blankCells(result.mask, result.cols, result.rows, result.paper);
      if (m.display) m.display.updateTexture(m.pixels);
    }
    return result;
  }
}

export class MtxFrameProbe implements FrameProbe {
  readonly transcribe: MtxTranscribeDriver;

  constructor(private readonly machine: MtxMachine) {
    this.transcribe = new MtxTranscribeDriver(machine);
  }

  sample(out: FrameIndicators): void {
    out.keyboard = this.machine.activity.kbdReads;
    out.joystick = out.mouse = out.tapeIn = 0;
    out.tapeLoad = this.machine.activity.casReads;
    out.beeper = 0;
    out.psg = this.machine.activity.psgWrites;
    out.videoFx = 0;
    out.disk = this.machine.activity.fdcAccesses;
    out.tapeTurbo = false;
    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = true;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = this.machine.activity.casReads > 0
      ? this.machine.cassette.currentBlock()
      : -1;
    out.fastRomLoading = false;
    out.tracingActive = this.machine.traceActive;
    const fdc = this.machine.fdc;
    const active = fdc.currentDrive;
    for (let unit = 0; unit < 2; unit++) {
      if (!this.machine.fdx.motorOn || unit !== active) out.driveLed[unit] = 0;
      else if (!fdc.isExecuting) out.driveLed[unit] = 1;
      else out.driveLed[unit] = fdc.isWriting ? 3 : 2;
      out.driveTrack[unit] = fdc.getUnitTrack(unit);
      out.driveSector[unit] = fdc.isExecuting && unit === active ? fdc.currentSector : -1;
      out.driveDirty[unit] = fdc.isDirty(unit) ? 1 : 0;
    }
    out.driveLed[2] = out.driveLed[3] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;

    // Drive-sound feed: the FDX's drives are 5.25" half-height units, so the
    // profile is fixed rather than read off the disk — an 80-track FDX image
    // is well past the capacity where the +3/CPC test would call a drive 3.5".
    // The motor lives in the FDX's own control latch (port 14h), not the
    // WD179x, and the selected drive is the one that can be heard.
    out.floppySlot = active;
    out.floppyMotor = this.machine.fdx.motorOn;
    out.floppyTrack = fdc.getUnitTrack(active);
    out.floppyProfile = DRIVE();
  }

  /** The FDX ticks its own controller from runFrame, so the only per-UI-frame
   *  bookkeeping left is consuming the format latch: a completed WRITE TRACK
   *  re-detects the disk's metadata through the bridge. */
  frameTick(out: FrameIndicators): void {
    const fdc = this.machine.fdc;
    if (fdc.formattedUnit >= 0) {
      out.formattedSlot = fdc.formattedUnit;
      fdc.formattedUnit = -1;
    }
  }

  diskImageForSlot(slot: number) {
    return slot < 2 ? this.machine.fdc.getDiskImage(slot) : null;
  }
}
