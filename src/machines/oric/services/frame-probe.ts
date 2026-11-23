/**
 * Oric frame probe and the TEXT overlay driver.
 *
 * Only the channels this machine actually has are written: the keyboard scan the
 * ROM's 100 Hz interrupt performs, the PSG (its "chip" LED), the ULA's blink
 * clock as the video-effect source, and the cassette once Phase 4 lands.
 */

import type { BasicListingLine } from '@/basic/types.ts';
import type {
  FrameIndicators, FramePaneProvider, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import {
  parseOricBasic, parseOricBasicVariables, readOricTokenTable, type OricTokenTable,
} from '@/basic/oric-basic-parser.ts';
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
  readonly panes: FramePaneProvider;
  readonly transcribe: OricTranscribeDriver;
  /** The keyword table, read once from the resident ROM (it never changes). */
  private tokenTable: OricTokenTable | null = null;
  private tokenRom: Uint8Array | null = null;

  constructor(private readonly machine: OricMachine) {
    this.transcribe = new OricTranscribeDriver(machine);
    this.panes = {
      basicListing: () => this.listing(),
      basicVars: () => parseOricBasicVariables(this.machine.memory.ram),
      memoryMap: () => this.machine.memoryMap(),
    };
  }

  /** The ROM's own keyword table, cached against the ROM it came from. */
  private tokens(): OricTokenTable {
    const rom = this.machine.memory.rom;
    if (this.tokenTable === null || this.tokenRom !== rom) {
      this.tokenTable = readOricTokenTable(rom);
      this.tokenRom = rom;
    }
    return this.tokenTable;
  }

  private listing(): BasicListingLine[] {
    return parseOricBasic(this.machine.memory.ram, this.tokens());
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
    out.tapeIn = 0;
    out.tapeLoad = 0;
    out.beeper = 0;
    // The PSG's sound LED follows whether a channel is audible.
    out.psg = m.psg.sounding ? 1 : 0;
    // The ULA's blink clock is the only "effect" this machine has.
    out.videoFx = (m.ula.fieldCounter & 0x20) !== 0 ? 1 : 0;
    out.disk = 0;
    out.tapeTurbo = false;
    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = true;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = m.traceActive;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
  }
}
