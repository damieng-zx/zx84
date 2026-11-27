/**
 * PCW FrameProbe — per-frame activity onto the generic indicator channels.
 *
 * `sample()` is a tier-3 hot path: it overwrites the shared struct in place and
 * must not allocate. The memory-layout pane lives in `inspect.ts`.
 */

import type {
  FrameIndicators, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { fixedDrive, type DriveSound } from '@/media/floppy/floppy-sound.ts';
import type { PcwMachine } from '../pcw-machine.ts';
import { pcwDriveType } from '../models.ts';

/**
 * TEXT-overlay driver.
 *
 * Nothing to set up: the PCW's transcription re-reads the bitmap every frame,
 * so the flag only records whether the bridge still owes us a deactivate.
 */
class PcwTranscribeDriver implements TranscribeDriver {
  private on = false;
  constructor(private readonly m: PcwMachine) {}

  get active(): boolean { return this.on; }
  activate(): void { this.on = true; }

  deactivate(): void {
    this.on = false;
    // The blanked cells were painted into the frame buffer, so the picture
    // underneath only returns once the ASIC redraws it.
    this.m.requestRedraw();
  }

  run(): { text: string; html: string; grid: OcrGridName } {
    const result = this.m.ocrScreenStyled();
    if (result.cells) {
      this.m.blankTextCells(result.cells);
      this.m.display?.updateTexture(this.m.pixels);
    }
    return { text: result.text, html: result.html, grid: result.grid };
  }
}

export class PcwFrameProbe implements FrameProbe {
  readonly transcribe: PcwTranscribeDriver;
  /** Fixed per model: the 8000s and the 9512 are 3" CF2, the 9256 is 3.5".
   *  Closed over once here so `sample()` still allocates nothing. */
  private readonly drive: DriveSound;

  constructor(private readonly m: PcwMachine) {
    this.transcribe = new PcwTranscribeDriver(m);
    this.drive = fixedDrive(pcwDriveType(m.model));
  }

  sample(out: FrameIndicators): void {
    const m = this.m;
    const a = m.activity;

    out.keyboard = a.kbdReads;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = 0;
    out.tapeLoad = 0;
    out.beeper = a.beeperWrites;
    out.psg = 0;
    out.videoFx = 0;
    out.disk = a.fdcAccesses;
    out.tapeTurbo = false;

    // No cassette hardware at all, so every tape channel reports idle.
    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = false;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = this.m.traceActive;

    const fdc = m.fdc;
    const fitted = m.driveCount;
    const activeUnit = fdc.motorOn ? fdc.currentUnit & 1 : -1;
    let soundSlot = -1;
    for (let u = 0; u < 4; u++) {
      if (u >= fitted) { out.driveLed[u] = -1; continue; }
      const motor = activeUnit === u;
      out.driveLed[u] = !motor ? 0
        : fdc.isWriting ? 3
        : fdc.isExecuting ? 2
        : 1;
      out.driveTrack[u] = fdc.getUnitTrack(u);
      out.driveSector[u] = fdc.currentSector;
      out.driveDirty[u] = fdc.isDirty(u) ? 1 : 0;
      if (motor && soundSlot < 0) soundSlot = u;
    }

    out.mdvCount = 0;
    out.mdvMotorMask = 0;

    // Drive-sound feed. A PCW was never re-fitted in the field the way a +3 or
    // a CPC was, so the mechanism follows the model, not the disc in it.
    out.floppySlot = soundSlot;
    out.floppyMotor = soundSlot >= 0;
    out.floppyTrack = soundSlot >= 0 ? fdc.getUnitTrack(soundSlot) : 0;
    out.floppyProfile = this.drive();
  }

  frameTick(): void {
    this.m.fdc.tickFrame();
  }

  diskImageForSlot(slot: number): DskImage | null {
    return slot < this.m.driveCount ? this.m.fdc.getDiskImage(slot) : null;
  }
}
