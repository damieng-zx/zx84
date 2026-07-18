/**
 * Einstein FrameProbe — keyboard/disk/PSG activity, the two WD1770 drive
 * panel slots, and the OCR text-overlay driver. The Einstein has no cassette
 * transport (its deck is inert) and ticks its own FDC inside runFrame, so
 * there is no frameTick here. See docs/re-architecture.md §3.3/§5 Phase 5.
 */

import type {
  FrameIndicators, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import type { OcrGridName } from '@/debug/screen-text.ts';

class EinsteinTranscribeDriver implements TranscribeDriver {
  constructor(private readonly m: EinsteinMachine) {}
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

export class EinsteinFrameProbe implements FrameProbe {
  readonly transcribe: EinsteinTranscribeDriver;

  constructor(private readonly m: EinsteinMachine) {
    this.transcribe = new EinsteinTranscribeDriver(m);
  }

  sample(out: FrameIndicators): void {
    const m = this.m;
    const a = m.activity;

    out.keyboard = a.kbdReads;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = 0;
    out.tapeLoad = 0;
    out.beeper = 0;
    out.psg = a.ayWrites > 5 ? 1 : 0;
    out.videoFx = 0;
    out.disk = a.fdcAccesses;
    out.tapeTurbo = false;

    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = true;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = false;

    // Drive A:/B: track/sector readout + LED (WD1770 units 0/1).
    const fdc = m.fdc;
    const active = fdc.currentDrive;
    for (let u = 0; u < 2; u++) {
      if (!fdc.motorOn || u !== active) out.driveLed[u] = 0;
      else if (!fdc.isExecuting) out.driveLed[u] = 1;
      else out.driveLed[u] = fdc.isWriting ? 3 : 2;
      out.driveTrack[u] = fdc.getUnitTrack(u);
      out.driveSector[u] = fdc.isExecuting && u === active ? fdc.currentSector : -1;
      out.driveDirty[u] = fdc.isDirty(u) ? 1 : 0;
    }
    out.driveLed[2] = out.driveLed[3] = -1;

    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyProfile = -1;
  }
}
