/**
 * Vic20FrameProbe — the status bar's and Memory pane's view of the VIC-20.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSnapshot, TranscribeDriver,
} from '@/machines/machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import { parseC64Basic, parseC64BasicVariables } from '@/basic/c64-basic-parser.ts';
import { hex16 } from '@/utils/hex.ts';
import type { Vic20Machine } from '../vic20-machine.ts';
import { sampleCbmDrives } from '@/machines/shared/cbm/drive-services.ts';

function vic20MemoryMap(m: Vic20Machine): MemoryMapSnapshot {
  const e = m.memory.expansion;
  const cart = m.memory.cart;
  // Cartridge ROM answers ahead of any RAM in its block.
  const block = (n: 1 | 2 | 3 | 5, on: boolean): string =>
    (cart?.blocks.has(n) ? 'Cartridge ROM' : on ? 'RAM (expansion)' : 'Empty');
  const ram = (on: boolean): string => (on ? 'RAM (expansion)' : 'Empty');
  const cpuAddr = (vicAddr: number): number => ((vicAddr & 0x2000) === 0 ? 0x8000 : 0) | (vicAddr & 0x1FFF);
  return {
    slots: [
      { range: 'E000-FFFF', read: 'KERNAL ROM' },
      { range: 'C000-DFFF', read: 'BASIC ROM' },
      { range: 'A000-BFFF', read: block(5, e.blk5) },
      { range: '9800-9FFF', read: 'I/O 2-3 (expansion port)' },
      { range: '9400-97FF', read: 'Colour RAM' },
      { range: '9000-93FF', read: 'VIC, VIA 1, VIA 2' },
      { range: '8000-8FFF', read: 'Character ROM' },
      { range: '6000-7FFF', read: block(3, e.blk3) },
      { range: '4000-5FFF', read: block(2, e.blk2) },
      { range: '2000-3FFF', read: block(1, e.blk1) },
      { range: '1000-1FFF', read: 'RAM', flags: ['screen'] },
      { range: '0400-0FFF', read: ram(e.ram123) },
      { range: '0000-03FF', read: 'RAM' },
    ],
    registers: [
      { name: 'Screen', value: `$${hex16(cpuAddr(m.vic.screenAddress))}` },
      { name: 'Characters', value: `$${hex16(cpuAddr(m.vic.charAddress))}` },
      { name: 'Colour', value: `$${hex16(0x9400 | (m.vic.screenAddress & 0x3FF))}` },
    ],
  };
}

/** TEXT overlay: read the character screen, then blank what it read. */
class Vic20TranscribeDriver implements TranscribeDriver {
  private _active = false;
  constructor(private readonly m: Vic20Machine) {}
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

export class Vic20FrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;
  readonly transcribe: Vic20TranscribeDriver;

  constructor(private readonly m: Vic20Machine) {
    this.transcribe = new Vic20TranscribeDriver(m);
    this.panes = {
      memoryMap: () => vic20MemoryMap(this.m),
      // BASIC V2 keeps its program and variable pointers where the C64's does.
      basicListing: () => parseC64Basic(this.m.memory.ram),
      basicVars: () => parseC64BasicVariables(this.m.memory.ram),
    };
  }

  sample(out: FrameIndicators): void {
    const m = this.m;
    out.keyboard = m.activity.kbdReads;
    out.joystick = m.activity.joyReads;
    out.mouse = 0;
    out.tapeIn = m.activity.tapeEdges;
    out.tapeLoad = m.activity.tapeEdges;
    out.beeper = 0;
    out.psg = m.activity.soundWrites;
    out.videoFx = 0;
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
