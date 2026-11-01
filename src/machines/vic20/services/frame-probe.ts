/**
 * Vic20FrameProbe — the status bar's and Memory pane's view of the VIC-20.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSnapshot,
} from '@/machines/machine.ts';
import { parseC64Basic, parseC64BasicVariables } from '@/basic/c64-basic-parser.ts';
import { hex16 } from '@/utils/hex.ts';
import type { Vic20Machine } from '../vic20-machine.ts';

function vic20MemoryMap(m: Vic20Machine): MemoryMapSnapshot {
  const e = m.memory.expansion;
  const ram = (on: boolean): string => (on ? 'RAM (expansion)' : 'Empty');
  const cpuAddr = (vicAddr: number): number => ((vicAddr & 0x2000) === 0 ? 0x8000 : 0) | (vicAddr & 0x1FFF);
  return {
    slots: [
      { range: 'E000-FFFF', read: 'KERNAL ROM' },
      { range: 'C000-DFFF', read: 'BASIC ROM' },
      { range: 'A000-BFFF', read: ram(e.blk5) },
      { range: '9800-9FFF', read: 'I/O 2-3 (expansion port)' },
      { range: '9400-97FF', read: 'Colour RAM' },
      { range: '9000-93FF', read: 'VIC, VIA 1, VIA 2' },
      { range: '8000-8FFF', read: 'Character ROM' },
      { range: '6000-7FFF', read: ram(e.blk3) },
      { range: '4000-5FFF', read: ram(e.blk2) },
      { range: '2000-3FFF', read: ram(e.blk1) },
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

export class Vic20FrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;

  constructor(private readonly m: Vic20Machine) {
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
    out.tapeIn = 0;
    out.tapeLoad = 0;
    out.beeper = 0;
    out.psg = 0;
    out.videoFx = 0;
    out.disk = 0;
    out.tapeTurbo = false;
    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = false;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = m.traceActive;
    for (let unit = 0; unit < 4; unit++) out.driveLed[unit] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyMotor = false;
  }
}
