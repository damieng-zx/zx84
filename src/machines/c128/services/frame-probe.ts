/**
 * C128FrameProbe — the status bar's view of the 128. The Memory pane's layout
 * and the BASIC panes live in `inspect.ts` (on demand, may allocate).
 */

import type {
  FrameIndicators, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import type { C128Machine } from '../c128-machine.ts';
import { sampleCbmDrives } from '@/machines/shared/cbm/drive-services.ts';


/** TEXT overlay: read the text screen — whichever of the two the canvas is
 *  showing — then blank what it read. Both chips keep character codes in
 *  their screen RAM, so a match is a cell whose glyph is a font character. */
class C128TranscribeDriver implements TranscribeDriver {
  private _active = false;
  constructor(private readonly m: C128Machine) {}
  get active(): boolean { return this._active; }
  activate(): void { this._active = true; }
  deactivate(): void { this._active = false; }
  run(): {
    text: string; html: string; grid: OcrGridName;
    field: { x: number; y: number; width: number; height: number };
  } {
    const m = this.m;
    const result = m.ocrScreenStyled();
    if (result.mask.some(Boolean)) {
      m.blankCells(result.mask, result.paper);
      m.display?.updateTexture(m.pixels);
    }
    return { text: result.text, html: result.html, grid: result.grid, field: m.textField };
  }
}

export class C128FrameProbe implements FrameProbe {
  readonly transcribe: C128TranscribeDriver;

  constructor(private readonly m: C128Machine) {
    this.transcribe = new C128TranscribeDriver(m);
  }

  sample(out: FrameIndicators): void {
    const m = this.m;
    out.keyboard = m.activity.kbdReads;
    out.joystick = m.activity.joyReads;
    out.mouse = 0;
    out.tapeIn = m.activity.tapeEdges;
    out.tapeLoad = m.activity.tapeEdges;
    out.beeper = 0;
    out.psg = m.activity.sidWrites;
    out.videoFx = 0;
    out.columns = m.showing80 ? 80 : 40;
    const tape = m.tape;
    out.tapeTurbo = m.tapeTurboActive;
    out.tapeLoaded = tape.blocks.length > 0;
    out.tapePlaying = tape.playing && !tape.paused;
    out.tapePaused = tape.paused;
    out.tapeFinished = tape.finished;
    out.tapePosition = tape.position;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = m.traceActive;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    sampleCbmDrives(out, m.drives);
  }
}
