/**
 * Oric frame probe and the TEXT overlay driver.
 *
 * Only the channels this machine actually has are written: the keyboard scan the
 * ROM's 100 Hz interrupt performs, the PSG (its "chip" LED), the ULA's blink
 * clock as the video-effect source, and the cassette once Phase 4 lands. The
 * memory-layout and BASIC panes are pull-on-demand and live in `inspect.ts`.
 */

import type {
  FrameIndicators, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import type { OricMachine } from '../oric-machine.ts';

class OricTranscribeDriver implements TranscribeDriver {
  private _active = false;
  constructor(private readonly m: OricMachine) {}
  get active(): boolean { return this._active; }
  activate(): void { this._active = true; }
  deactivate(): void { this._active = false; }

  run() {
    const m = this.m;
    const result = m.ocrScreenStyled();
    if (result.mask.some(Boolean)) {
      m.blankCells(result.mask);
      if (m.display) m.display.updateTexture(m.pixels);
    }
    return { text: result.text, html: result.html, grid: result.grid, field: m.textField };
  }
}

export class OricFrameProbe implements FrameProbe {
  readonly transcribe: OricTranscribeDriver;

  constructor(private readonly machine: OricMachine) {
    this.transcribe = new OricTranscribeDriver(machine);
  }

  frameTick(_out: FrameIndicators): void {
    // Nothing latched across frames yet: the cassette's EAR edge counter lands
    // with the deck.
  }

  /** Pure read — overwrite every channel this machine owns, allocating nothing. */
  sample(out: FrameIndicators): void {
    const m = this.machine;
    out.keyboard = m.activity.keyboardReads;
    out.joystick = 0;
    out.mouse = 0;
    // The cassette's read line (the data line the VIA's CB1 sees) and whether
    // the ROM is pulling data off it right now.
    const tape = m.tape;
    out.tapeIn = tape.earBit;
    out.tapeLoad = tape.playing && !tape.paused ? 1 : 0;
    out.beeper = 0;
    // The PSG's sound LED follows whether a channel is audible.
    out.psg = m.psg.sounding ? 1 : 0;
    // The ULA's blink clock is the only "effect" this machine has.
    out.videoFx = (m.ula.fieldCounter & 0x20) !== 0 ? 1 : 0;
    // The Microdisc's controller, when the interface is fitted: its accesses
    // this frame drive the disk LED, as `fdcAccesses` does on every other
    // machine with a floppy controller.
    out.disk = m.activity.fdcAccesses;
    out.tapeTurbo = false;
    out.tapeLoaded = tape.loaded;
    out.tapePlaying = tape.playing && !tape.paused;
    out.tapePaused = tape.paused;
    out.tapeFinished = tape.finished;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = m.traceActive;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
  }
}
