/**
 * NewBrain FrameProbe — keyboard scanning, cassette-port traffic and the deck
 * transport state. No drives, mice or sound.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSnapshot, TranscribeDriver,
} from '@/machines/machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import { parseNewBrainBasic, parseNewBrainBasicVariables } from '@/basic/newbrain-basic-parser.ts';
import { DRIVE_PROFILE } from '@/media/floppy/floppy-sound.ts';
import type { NewBrainMachine } from '../newbrain-machine.ts';

function newBrainMemoryMap(m: NewBrainMachine): MemoryMapSnapshot {
  const up = m.memory.poweredUp;
  return {
    slots: up ? [
      { range: '0000-7FFF', read: 'RAM (32K)', flags: ['screen'] },
      { range: '8000-9FFF', read: '(expansion)' },
      { range: 'A000-BFFF', read: 'ROM A' },
      { range: 'C000-DFFF', read: 'ROM CD' },
      { range: 'E000-FFFF', read: 'ROM EF' },
    ] : [
      { range: '0000-FFFF', read: 'ROM EF (power-up)' },
    ],
    registers: [
      { name: 'ENRG', value: m.enrg.toString(16).toUpperCase().padStart(2, '0') },
      { name: 'TVL', value: (m.tvl & 0x7FFF).toString(16).toUpperCase().padStart(4, '0') },
      { name: 'TVCTL', value: m.tvctl.toString(16).toUpperCase().padStart(2, '0') },
    ],
  };
}

/**
 * TEXT-overlay driver. The text is read from RAM every frame, so there is
 * nothing to set up: the flag only records whether the bridge still owes a
 * deactivate. The blanked cells were painted into the frame buffer, so the
 * glyphs underneath only return once the next frame redraws them.
 */
class NewBrainTranscribeDriver implements TranscribeDriver {
  private on = false;
  constructor(private readonly m: NewBrainMachine) {}

  get active(): boolean { return this.on; }
  activate(): void { this.on = true; }
  deactivate(): void { this.on = false; }

  run(): { text: string; html: string; grid: OcrGridName } {
    const result = this.m.ocrScreenStyled();
    this.m.blankTextCells(result);
    return { text: result.text, html: result.html, grid: result.grid };
  }
}

export class NewBrainFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;
  readonly transcribe: NewBrainTranscribeDriver;

  constructor(private readonly m: NewBrainMachine) {
    this.transcribe = new NewBrainTranscribeDriver(m);
    this.panes = {
      memoryMap: () => newBrainMemoryMap(m),
      // BASIC keeps its program and symbol tables in the 32K of RAM.
      basicListing: () => parseNewBrainBasic(m.memory.ram),
      basicVars: () => parseNewBrainBasicVariables(m.memory.ram),
    };
  }

  sample(out: FrameIndicators): void {
    const m = this.m;
    const a = m.activity;

    out.keyboard = a.kbdScans > 0 ? 1 : 0;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = a.tapeReads;
    out.tapeLoad = a.tapeReads;
    out.beeper = 0;
    out.psg = 0;
    out.videoFx = 0;
    out.disk = 0;
    out.tapeTurbo = false;

    const tape = m.tape;
    out.tapeLoaded = tape.loaded;
    out.tapePlaying = tape.playing;
    out.tapePaused = tape.paused;
    out.tapeFinished = tape.finished;
    out.tapePosition = tape.position;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = m.traceActive;

    out.driveLed[0] = out.driveLed[1] = out.driveLed[2] = out.driveLed[3] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyProfile = DRIVE_PROFILE.keep;
  }
}
