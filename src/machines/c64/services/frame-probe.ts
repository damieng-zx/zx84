/**
 * C64FrameProbe — the status bar's and Memory pane's view of the 64.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSnapshot, TranscribeDriver,
} from '@/machines/machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import { parseC64Basic, parseC64BasicVariables } from '@/basic/c64-basic-parser.ts';
import { hex8 } from '@/utils/hex.ts';
import type { C64Machine } from '../c64-machine.ts';
import { C64_CART_TYPE_NAMES } from '../cartridge.ts';

function c64MemoryMap(m: C64Machine): MemoryMapSnapshot {
  const mem = m.memory;
  const vicBank = mem.vicBase >> 14;
  const screen = mem.vicBase | ((m.vic.regs[0x18] & 0xF0) << 6);
  const cart = mem.cart;
  const slots = [
    { range: 'E000-FFFF', read: mem.romhE ? 'Cartridge ROMH' : mem.kernalIn ? 'KERNAL ROM' : 'RAM' },
    { range: 'D000-DFFF', read: mem.ioIn ? 'I/O' : mem.charIn ? 'Character ROM' : 'RAM' },
    { range: 'C000-CFFF', read: mem.ultimax ? 'Open' : 'RAM' },
    { range: 'A000-BFFF', read: mem.romhA ? 'Cartridge ROMH' : mem.ultimax ? 'Open' : mem.basicIn ? 'BASIC ROM' : 'RAM' },
  ];
  if (cart) {
    slots.push({ range: '8000-9FFF', read: mem.romlIn ? 'Cartridge ROML' : 'RAM' });
    slots.push({ range: '1000-7FFF', read: mem.ultimax ? 'Open' : 'RAM' });
    slots.push({ range: '0000-0FFF', read: 'RAM' });
  } else {
    slots.push({ range: '0000-9FFF', read: 'RAM' });
  }
  const registers = [
    { name: '6510 port', value: `$${hex8(mem.portData)} (DDR $${hex8(mem.portDdr)})` },
    { name: 'VIC bank', value: `${vicBank} ($${hex8(vicBank << 6)}00)` },
    { name: 'Screen', value: `$${screen.toString(16).toUpperCase().padStart(4, '0')}` },
    { name: 'Cassette', value: mem.motorOn ? 'motor on' : 'motor off' },
  ];
  if (cart) {
    const { exrom, game } = cart.lines;
    registers.push({ name: 'Cartridge', value: `${C64_CART_TYPE_NAMES[cart.type]}, EXROM ${exrom} GAME ${game}${mem.ultimax ? ' (Ultimax)' : ''}` });
  }
  return { slots, registers };
}

/** TEXT overlay: read the character screen, then blank what it read. */
class C64TranscribeDriver implements TranscribeDriver {
  private _active = false;
  constructor(private readonly m: C64Machine) {}
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

export class C64FrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;
  readonly transcribe: C64TranscribeDriver;

  constructor(private readonly m: C64Machine) {
    this.transcribe = new C64TranscribeDriver(m);
    this.panes = {
      memoryMap: () => c64MemoryMap(this.m),
      // BASIC V2 keeps its program and variable tables in the 64K of RAM.
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
    out.psg = m.activity.sidWrites;
    out.videoFx = 0;
    out.disk = 0;
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
    for (let unit = 0; unit < 4; unit++) out.driveLed[unit] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyMotor = false;
    // 0 off, 1 motor, 2 reading, 3 writing: a drive's LED is lit while it works.
    m.drives.forEach((drive, unit) => {
      out.driveLed[unit] = !drive.motorOn ? 0 : drive.isWriting ? 3 : drive.ledOn ? 2 : 1;
      out.driveTrack[unit] = drive.currentTrack;
      out.driveSector[unit] = -1;
      out.driveDirty[unit] = drive.dirty ? 1 : 0;
      if (drive.motorOn) out.disk = 1;
    });
    // The floppy sound follows the first drive running, else the first drive.
    const running = m.drives.findIndex(d => d.motorOn);
    const sounding = running >= 0 ? running : 0;
    const drive = m.drives[sounding];
    if (drive) {
      out.floppySlot = sounding;
      out.floppyMotor = drive.motorOn;
      out.floppyTrack = drive.currentTrack;
      out.floppyProfile = drive.model === '1581' ? 1 : 2;      // 3.5 inch, or 5.25 inch
    }
  }
}
