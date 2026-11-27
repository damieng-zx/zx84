/**
 * CPC FrameProbe — maps the CPC's per-frame activity counters and cassette
 * transport onto the generic FrameIndicators channels, plus the OCR text-overlay
 * driver. The memory-layout and Locomotive BASIC panes live in `inspect.ts`.
 *
 * The disk channels are the +3's, because the hardware is: the same uPD765A,
 * the same 3" CF2, so the drive panel, the drive-sound synth and the
 * post-FORMAT metadata refresh are fed the same way on both.
 */

import type {
  FrameIndicators, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import { DRIVE_PROFILE, byCapacity } from '@/media/floppy/floppy-sound.ts';

/** The built-in unit is a 3" CF2, but a 720K image in either drive means a
 *  3.5" was fitted alongside it — the +3's case, and its test. */
const DRIVE = byCapacity;

class CpcTranscribeDriver implements TranscribeDriver {
  constructor(private readonly c: CpcMachine) {}
  get active(): boolean { return this.c.screenText.active; }
  activate(): void { this.c.screenText.activate(); }
  deactivate(): void { this.c.screenText.deactivate(); }
  run(): { text: string; html: string; grid: OcrGridName } {
    const c = this.c;
    const result = c.ocrScreenStyled();
    if (result.mask.length > 0) {
      c.blankCells(result.mask, result.cols, result.rows, result.paper);
      if (c.display) c.display.updateTexture(c.pixels);
    }
    return result;
  }
}

export class CpcFrameProbe implements FrameProbe {
  readonly transcribe: CpcTranscribeDriver;

  constructor(private readonly c: CpcMachine) {
    this.transcribe = new CpcTranscribeDriver(c);
  }

  sample(out: FrameIndicators): void {
    const c = this.c;
    const a = c.activity;
    const tape = c.tape;

    out.keyboard = a.kbdReads;
    out.joystick = 0;
    out.mouse = a.mouseReads > 0 || (c.amxMouse.enabled && c.amxMouse.active) ? 1 : 0;
    out.tapeIn = 0;
    out.tapeLoad = a.tapeReads;
    out.beeper = 0;
    out.psg = a.ayWrites > 5 ? 1 : 0;
    out.videoFx = 0;
    out.disk = a.fdcAccesses;
    out.tapeTurbo = false;

    out.tapeLoaded = tape.loaded;
    out.tapePlaying = tape.playing;
    out.tapePaused = tape.paused;
    out.tapeFinished = tape.finished;
    out.tapePosition = tape.position;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = this.c.traceActive;

    // Panel slots A:/B: are the uPD765A's two units; C:/D: are the Spectrum's
    // +D/Beta drives and never exist here. A cassette-only model (464, or the
    // GX4000) has no controller to report, so every slot stays absent.
    out.driveLed[2] = out.driveLed[3] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyProfile = DRIVE_PROFILE.keep;

    if (!c.hasFdc) {
      out.driveLed[0] = out.driveLed[1] = -1;
      return;
    }

    const fdc = c.fdc;
    const active = fdc.currentUnit;
    for (let unit = 0; unit < 2; unit++) {
      if (unit >= c.driveCount) { out.driveLed[unit] = -1; continue; }   // no drive on this line
      if (!fdc.motorOn || unit !== active) out.driveLed[unit] = 0;
      else if (!fdc.isExecuting) out.driveLed[unit] = 1;
      else out.driveLed[unit] = fdc.isWriting ? 3 : 2;
      out.driveTrack[unit] = fdc.getUnitTrack(unit);
      out.driveSector[unit] = fdc.isExecuting && unit === active ? fdc.currentSector : -1;
      out.driveDirty[unit] = fdc.isDirty(unit) ? 1 : 0;
    }

    // Drive-sound feed: the selected drive is the one that can be heard.
    const heard = active === 0 ? 0 : 1;
    out.floppySlot = heard;
    out.floppyMotor = fdc.motorOn;
    out.floppyTrack = fdc.getUnitTrack(heard);
    out.floppyProfile = DRIVE(fdc.getDiskImage(heard));
  }

  frameTick(out: FrameIndicators): void {
    const c = this.c;

    if (c.hasFdc) {
      // Decay the FDC's latched display state — without this the read/write
      // LED never falls back to the motor colour, since isExecuting stays
      // true while the latch is up.
      c.fdc.tickFrame();
      // A completed FORMAT re-detects disk metadata via the bridge.
      if (c.fdc.formattedUnit >= 0) {
        out.formattedSlot = c.fdc.formattedUnit;
        c.fdc.formattedUnit = -1;
      }
    }

    // Auto-rewind: the tape just ran out → rewind, paused, ready to replay.
    if (c.tapeAutoRewind && c.tape.loaded && !c.tape.playing && c.tape.finished) {
      c.tape.position = 0;
      c.tape.paused = true;
      c.tape.startPlayback();
    }
  }

  diskImageForSlot(slot: number): DskImage | null {
    return slot < this.c.driveCount ? this.c.fdc.getDiskImage(slot) : null;
  }
}
