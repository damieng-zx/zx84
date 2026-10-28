/**
 * C64FrameProbe — the status bar's and Memory pane's view of the 64.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSnapshot,
} from '@/machines/machine.ts';
import { hex8 } from '@/utils/hex.ts';
import type { C64Machine } from '../c64-machine.ts';

function c64MemoryMap(m: C64Machine): MemoryMapSnapshot {
  const mem = m.memory;
  const vicBank = mem.vicBase >> 14;
  const screen = mem.vicBase | ((m.vic.regs[0x18] & 0xF0) << 6);
  return {
    slots: [
      { range: 'E000-FFFF', read: mem.kernalIn ? 'KERNAL ROM' : 'RAM' },
      { range: 'D000-DFFF', read: mem.ioIn ? 'I/O' : mem.charIn ? 'Character ROM' : 'RAM' },
      { range: 'C000-CFFF', read: 'RAM' },
      { range: 'A000-BFFF', read: mem.basicIn ? 'BASIC ROM' : 'RAM' },
      { range: '0000-9FFF', read: 'RAM' },
    ],
    registers: [
      { name: '6510 port', value: `$${hex8(mem.portData)} (DDR $${hex8(mem.portDdr)})` },
      { name: 'VIC bank', value: `${vicBank} ($${hex8(vicBank << 6)}00)` },
      { name: 'Screen', value: `$${screen.toString(16).toUpperCase().padStart(4, '0')}` },
      { name: 'Cassette', value: mem.motorOn ? 'motor on' : 'motor off' },
    ],
  };
}

export class C64FrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;

  constructor(private readonly m: C64Machine) {
    this.panes = { memoryMap: () => c64MemoryMap(this.m) };
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
  }
}
