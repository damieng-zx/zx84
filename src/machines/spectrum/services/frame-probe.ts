/**
 * Spectrum FrameProbe — maps the machine's per-frame activity counters,
 * transport state, and drive telemetry onto the generic FrameIndicators
 * channels.
 *
 * `sample()` is a pure read on the hot once-per-rAF path: no allocation, no
 * machine mutation. Device bookkeeping that must run once per *UI* frame
 * (FDC frame ticks, format latch consumption, tape auto-rewind) lives in
 * `frameTick()`, which the bridge calls at its signal-batch cadence — throttled
 * under turbo, exactly like the pre-probe frame-bridge body.
 */

import type {
  FrameIndicators, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { FloppyController } from '@/cores/floppy-controller.ts';
import type { FontSource, OcrGridName } from '@/ocr/ocr.ts';
import { DRIVE_PROFILE, byCapacity, fixedDrive } from '@/media/floppy/floppy-sound.ts';

/** Two disk interfaces, two drives to declare. The +3's built-in unit is a 3"
 *  CF2 but was routinely fitted with a 720K 3.5", so it follows the disk; the
 *  +D always used 3.5" drives, and the Beta shares its sound model. */
const FDC_DRIVE = byCapacity;
const WD_DRIVE = fixedDrive('3.5inch');

/** Compute a drive-panel slot's LED state: 0 off, 1 motor, 2 read, 3 write.
 *  Mirrors the old frame-bridge renderDriveStatus() decision tree. */
function driveLed(fdc: FloppyController, unit: number, activeUnit: number): number {
  if (!fdc.motorOn || unit !== activeUnit) return 0;
  if (!fdc.isExecuting) return 1;
  return fdc.isWriting ? 3 : 2;
}

/** Fill one A..D panel slot from an FDC unit. Sector shows only while the
 *  active unit is executing (else -1 → '--'), as before. */
function fillDriveSlot(out: FrameIndicators, slot: number, fdc: FloppyController, unit: number, activeUnit: number): void {
  out.driveLed[slot] = driveLed(fdc, unit, activeUnit);
  out.driveTrack[slot] = fdc.getUnitTrack(unit);
  out.driveSector[slot] = fdc.isExecuting && unit === activeUnit ? fdc.currentSector : -1;
  out.driveDirty[slot] = fdc.isDirty(unit) ? 1 : 0;
}

/** The WD-family interface currently wired to panel slots C/D: the +D, else
 *  the Beta Disk (mutually exclusive), else null. */
function activeWd(s: Spectrum): FloppyController | null {
  return s.mgtPlusD.enabled ? s.mgtPlusD.fdc : s.betaDisk.enabled ? s.betaDisk.fdc : null;
}

class SpectrumTranscribeDriver implements TranscribeDriver {
  private extraFonts: readonly FontSource[] | undefined;

  constructor(private readonly s: Spectrum) {}

  get active(): boolean { return this.s.screenText.active; }

  activate(extraFonts?: readonly FontSource[]): void {
    this.s.screenText.activate();
    this.extraFonts = extraFonts;
  }

  deactivate(): void {
    this.s.screenText.deactivate();
    this.extraFonts = undefined;
  }

  run(): { text: string; html: string; grid: OcrGridName } {
    const s = this.s;
    const result = s.ocrScreenStyled(this.extraFonts as FontSource[] | undefined, 'auto');
    // Blank matched character cells in the framebuffer and re-upload, so the
    // crisp overlay glyphs replace the bitmap underneath.
    if (result.mask.length > 0) {
      // Hi-res cells are counted in hi-res pixels, two to a logical one; the ULA
      // blanks (and picks the paper for) the picture on show, which is the screen bank.
      const hires = s.ula.isHiRes;
      s.ula.blankCells(
        s.textScreen, result.mask, 0x4000,
        hires ? result.cellWidth / 2 : result.cellWidth, result.cellHeight, result.cols, result.rows,
      );
      if (s.display) s.display.updateTexture(s.ula.pixels);
    }
    return result;
  }
}

export class SpectrumFrameProbe implements FrameProbe {
  readonly transcribe: SpectrumTranscribeDriver;

  constructor(private readonly s: Spectrum) {
    this.transcribe = new SpectrumTranscribeDriver(s);
  }

  sample(out: FrameIndicators): void {
    const s = this.s;
    const a = s.activity;
    const v = s.variant;
    const tape = s.tape;

    out.keyboard = a.ulaReads;
    out.joystick = a.kempstonReads;
    out.mouse = a.mouseReads;
    out.tapeIn = a.earReads;
    // TAPE LED = the tape is actively rolling; ROM LD-BYTES hits alone miss
    // custom/turbo loaders (they poll the port from their own code).
    out.tapeLoad = (tape.playing && !tape.paused) || a.tapeLoads > 0 ? 1 : 0;
    // The SpecDrum DAC is another analogue output, so its writes light BEEP too.
    out.beeper = a.beeperToggled || a.specdrumWrites > 0 ? 1 : 0;
    out.psg = a.ayWrites > 5 ? 1 : 0;
    out.videoFx = a.attrWrites > 768 ? 1 : 0;
    out.disk = (a.fdcAccesses > 0
      || (s.mgtPlusD.enabled && s.mgtPlusD.fdc.motorOn)
      || (s.betaDisk.enabled && s.betaDisk.fdc.motorOn)
      || (s.interface1.enabled && s.interface1.anyMotorOn)) ? 1 : 0;
    out.tapeTurbo = s.tapeTurboActive;

    out.tapeLoaded = tape.loaded;
    out.tapePlaying = tape.playing;
    out.tapePaused = tape.paused;
    out.tapeFinished = tape.finished;
    out.tapePosition = tape.position;
    out.casBlock = -1;
    const loadingNow = tape.loaded && tape.playing && !tape.paused && !tape.finished;
    out.fastRomLoading = loadingNow && s.tapeFastRom && a.tapeLoads > 0;

    out.tracingActive = s.tracing;

    // ── Drive panel slots: A/B = uPD765A, C/D = +D or Beta Disk ──
    out.driveLed[0] = out.driveLed[1] = out.driveLed[2] = out.driveLed[3] = -1;
    if (v.hasFDC) {
      const activeUnit = s.fdc.currentDrive;
      for (let u = 0; u < s.driveCount; u++) fillDriveSlot(out, u, s.fdc, u, activeUnit);
    }
    const wd = activeWd(s);
    if (wd) {
      const wdActive = wd.currentDrive;
      for (let u = 0; u < s.driveCount; u++) fillDriveSlot(out, 2 + u, wd, u, wdActive);
    }

    // Microdrive motors (IF1).
    out.mdvSector.fill(-1);
    if (s.interface1.enabled) {
      out.mdvCount = 8;
      let mask = 0;
      const drives = s.interface1.drives;
      for (let i = 0; i < 8; i++) {
        if (drives[i].motorOn) mask |= 1 << i;
        out.mdvSector[i] = drives[i].currentSector;
      }
      out.mdvMotorMask = mask;
    } else {
      out.mdvCount = 0;
      out.mdvMotorMask = 0;
    }

    // ── Floppy drive-sound feed (the +3 uPD765A, or the +D/Beta WD) ──
    // Slot picks the per-drive sound setting: 0/1 = A/B (+3), 2/3 = C/D (WD).
    out.floppySlot = -1;
    out.floppyProfile = DRIVE_PROFILE.keep;
    if (v.hasFDC) {
      out.floppySlot = s.fdc.currentDrive === 0 ? 0 : 1;
      out.floppyMotor = s.fdc.motorOn;
      out.floppyTrack = s.fdc.currentTrack;
      out.floppyProfile = FDC_DRIVE(s.fdc.getDiskImage(s.fdc.currentDrive));
    } else if (wd) {
      out.floppySlot = wd.currentDrive === 0 ? 2 : 3;
      out.floppyMotor = wd.motorOn;
      out.floppyTrack = wd.currentTrack;
      out.floppyProfile = WD_DRIVE();
    }
  }

  frameTick(out: FrameIndicators): void {
    const s = this.s;

    if (s.variant.hasFDC) {
      s.fdc.tickFrame();
      // A completed FORMAT re-detects disk metadata via the bridge.
      if (s.fdc.formattedUnit >= 0) {
        out.formattedSlot = s.fdc.formattedUnit;
        s.fdc.formattedUnit = -1;
      }
    }
    const wd = activeWd(s);
    if (wd) {
      wd.tickFrame();
      if (wd.formattedUnit >= 0) {
        out.formattedSlot = 2 + wd.formattedUnit;
        wd.formattedUnit = -1;
      }
    }

    // Auto-rewind: tape just ran out → rewind to start in play+paused state,
    // ready for the next EAR read to unpause.
    if (s.tapeAutoRewind && s.tape.loaded && !s.tape.playing && s.tape.finished) {
      s.tape.position = 0;
      s.tape.paused = true;
      s.tape.startPlayback();
    }
  }

  diskImageForSlot(slot: number): DskImage | null {
    const s = this.s;
    if (slot <= 1) return s.variant.hasFDC && slot < s.driveCount ? s.fdc.getDiskImage(slot) : null;
    const wd = activeWd(s);
    return wd && slot - 2 < s.driveCount ? wd.getDiskImage(slot - 2) : null;
  }
}
