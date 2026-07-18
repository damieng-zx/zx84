/**
 * MSX FrameProbe — keyboard/PSG/cassette-read activity and the instant-load
 * cassette's current-block highlight, plus the OCR text-overlay driver. The
 * MSX has no pulse tape transport, drives, or drive sound — those channels
 * stay absent, matching the pre-probe frame-bridge body exactly.
 */

import type {
  FrameIndicators, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';
import type { OcrGridName } from '@/ocr/spectrum.ts';

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
    out.tapeIn = 0;
    out.tapeLoad = a.casReads;
    out.beeper = 0;
    out.psg = a.ayWrites > 5 ? 1 : 0;
    out.videoFx = 0;
    out.disk = 0;
    out.tapeTurbo = false;

    // The MSX cassette is instant-load: no transport sync, only the
    // currently-read block highlight while CLOAD/BLOAD sweeps through.
    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = true;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = a.casReads > 0 ? m.cassette.currentBlock() : -1;
    out.fastRomLoading = false;
    out.tracingActive = false;

    out.driveLed[0] = out.driveLed[1] = out.driveLed[2] = out.driveLed[3] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyProfile = -1;
  }
}
