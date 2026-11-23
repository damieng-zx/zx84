/**
 * MSX FrameProbe — keyboard/PSG/cassette activity, the cassette deck's
 * transport state, the floppy interface's drives, plus the OCR text-overlay
 * driver. The memory-layout and BASIC panes live in `inspect.ts`.
 */

import type {
  FrameIndicators, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import { DRIVE_PROFILE, fixedDrive } from '@/media/floppy/floppy-sound.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';

/** The disk interface's drives are 3.5" units. */
const DRIVE = fixedDrive('3.5inch');

class MsxTranscribeDriver implements TranscribeDriver {
  constructor(private readonly m: MsxMachine) {}
  get active(): boolean { return this.m.screenText.active; }
  activate(): void { this.m.screenText.activate(); }
  deactivate(): void { this.m.screenText.deactivate(); }
  run(): { text: string; html: string; grid: OcrGridName } {
    const m = this.m;
    const result = m.ocrScreenStyled();
    if (result.mask.length > 0) {
      m.blankCells(result.mask, result.cols, result.rows, result.paper);
      if (m.display) m.display.updateTexture(m.pixels);
    }
    return result;
  }
}

export class MsxFrameProbe implements FrameProbe {
  readonly transcribe: MsxTranscribeDriver;

  constructor(private readonly m: MsxMachine) {
    this.transcribe = new MsxTranscribeDriver(m);
  }

  sample(out: FrameIndicators): void {
    const m = this.m;
    const a = m.activity;

    out.keyboard = a.kbdReads;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = a.tapeReads > 0 ? 1 : 0;
    out.tapeLoad = a.casReads + a.tapeReads;
    out.beeper = 0;
    out.psg = a.ayWrites > 5 ? 1 : 0;
    out.videoFx = 0;
    out.disk = a.fdcAccesses;
    out.tapeTurbo = m.tapeTurbo && m.tapeMoving;

    // The pulse-level deck's transport; the BIOS traps move it block by block.
    const tape = m.tape;
    out.tapeLoaded = tape.loaded;
    out.tapePlaying = tape.playing;
    out.tapePaused = tape.paused;
    out.tapeFinished = tape.finished;
    out.tapePosition = tape.position;
    out.casBlock = -1;
    out.fastRomLoading = a.casReads > 0;
    out.tracingActive = this.m.traceActive;

    out.driveLed[2] = out.driveLed[3] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;

    const fitted = m.floppyEnabled && m.diskIf.romLoaded;
    if (!fitted) {
      out.driveLed[0] = out.driveLed[1] = -1;
      out.floppySlot = -1;
      out.floppyProfile = DRIVE_PROFILE.keep;
      return;
    }
    const fdc = m.fdc;
    const active = m.diskIf.selectedDrive;
    for (let unit = 0; unit < 2; unit++) {
      if (!m.diskIf.motorOn || unit !== active) out.driveLed[unit] = 0;
      else if (!fdc.isExecuting) out.driveLed[unit] = 1;
      else out.driveLed[unit] = fdc.isWriting ? 3 : 2;
      out.driveTrack[unit] = fdc.getUnitTrack(unit);
      out.driveSector[unit] = fdc.isExecuting && unit === active ? fdc.currentSector : -1;
      out.driveDirty[unit] = fdc.isDirty(unit) ? 1 : 0;
    }
    out.floppySlot = active;
    out.floppyMotor = m.diskIf.motorOn;
    out.floppyTrack = fdc.getUnitTrack(active);
    out.floppyProfile = DRIVE();
  }

  /** The interface ticks its own controller from runFrame, so the only per-UI-
   *  frame bookkeeping left is consuming the format latch: a completed WRITE
   *  TRACK re-detects the disk's metadata through the bridge. */
  frameTick(out: FrameIndicators): void {
    const fdc = this.m.fdc;
    if (fdc.formattedUnit >= 0) {
      out.formattedSlot = fdc.formattedUnit;
      fdc.formattedUnit = -1;
    }
  }

  diskImageForSlot(slot: number) {
    return slot < 2 ? this.m.fdc.getDiskImage(slot) : null;
  }
}
