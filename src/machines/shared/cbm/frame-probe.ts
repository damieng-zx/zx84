/**
 * The TEXT overlay driver shared by the Commodore machines: read the
 * character screen as styled text, blank what was read in the machine's
 * framebuffer, and hand the overlay strings back. The machine supplies its
 * own OCR, blanking and display; this only sequences them.
 */

import type { OcrGridName } from '@/ocr/ocr.ts';
import type { TranscribeDriver } from '@/machines/machine.ts';

/** What a Commodore machine contributes to the shared TEXT overlay: its own
 *  OCR engine (per machine — the VIC-II, VDC and TED screens differ), the
 *  blanking that matches it, and the display to re-upload to. */
export interface CbmTranscribeMachine {
  /** Read the character screen as styled text, with the blanking mask. */
  ocrScreenStyled(): {
    text: string;
    html: string;
    grid: OcrGridName;
    mask: boolean[];
    paper: number[];
  };
  /** Blank the read cells to their background colour. */
  blankCells(mask: boolean[], paper: number[]): void;
  /** Re-upload the framebuffer after blanking. */
  readonly display: { updateTexture(pixels: Uint8Array): void } | null;
  readonly pixels: Uint8Array;
  /** Where the transcribed text sits, in buffer pixels. */
  readonly textField: { x: number; y: number; width: number; height: number };
}

/** TEXT overlay: read the character screen, then blank what it read. */
export class CbmTranscribeDriver implements TranscribeDriver {
  private _active = false;
  constructor(private readonly m: CbmTranscribeMachine) {}
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

/** The machine's own FrameProbe constructor work: the TEXT overlay. */
export function cbmTranscribe(m: CbmTranscribeMachine): TranscribeDriver {
  return new CbmTranscribeDriver(m);
}
