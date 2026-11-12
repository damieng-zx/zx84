/**
 * C128FrameProbe — the status bar's and Memory pane's view of the 128.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSnapshot,
} from '@/machines/machine.ts';
import { hex8 } from '@/utils/hex.ts';
import type { C128Machine } from '../c128-machine.ts';
import { sampleCbmDrives } from '@/machines/shared/cbm/drive-services.ts';

const ROM_AT_8000 = ['BASIC high ROM', 'Internal function ROM', 'External function ROM', 'RAM'];
const ROM_AT_C000 = ['System ROM (editor, KERNAL)', 'Internal function ROM', 'External function ROM', 'RAM'];

function c128MemoryMap(m: C128Machine): MemoryMapSnapshot {
  const mem = m.memory;
  const mmu = mem.mmu;
  const vicBank = mem.vicBase >> 14;
  const screen = mem.vicBase | ((m.vic.regs[0x18] & 0xF0) << 6);
  const cr = mmu.cr;
  // In C64 mode the 8502's port bits 0-2 are the 64's PLA lines.
  const pins = mem.portPins;
  const loram = (pins & 1) !== 0, hiram = (pins & 2) !== 0;
  const slots = m.c64Mode
    ? [
      { range: 'E000-FFFF', read: hiram ? '64 KERNAL ROM' : 'RAM' },
      { range: 'D000-DFFF', read: mem.ioIn ? 'I/O' : loram || hiram ? 'Character ROM' : 'RAM' },
      { range: 'C000-CFFF', read: 'RAM' },
      { range: 'A000-BFFF', read: loram && hiram ? '64 BASIC ROM' : 'RAM' },
      { range: '0000-9FFF', read: 'RAM' },
    ]
    : [
      { range: 'C000-FFFF', read: ROM_AT_C000[(cr >> 4) & 3] },
      { range: 'D000-DFFF', read: mem.ioIn ? 'I/O' : 'Character ROM / system ROM / RAM' },
      { range: '8000-BFFF', read: ROM_AT_8000[(cr >> 2) & 3] },
      { range: '4000-7FFF', read: cr & 0x02 ? 'RAM' : 'BASIC low ROM' },
      { range: '0000-3FFF', read: 'RAM' },
    ];
  const registers = [
    { name: 'Mode', value: `${m.c64Mode ? 'C64' : 'C128'}, ${m.cpuIs8502 ? '8502' : 'Z80'}` },
    { name: 'MMU CR', value: `$${hex8(cr)} (RAM block ${mmu.ramBlock})` },
    { name: 'MMU RCR', value: `$${hex8(mmu.rcr)} (common ${mmu.commonSize >> 10}K, VIC-IIe block ${mmu.vicBlock})` },
    { name: '8502 port', value: `$${hex8(mem.portData)} (DDR $${hex8(mem.portDdr)})` },
    { name: 'VIC bank', value: `${vicBank} ($${hex8(vicBank << 6)}00)` },
    { name: 'Screen', value: `$${screen.toString(16).toUpperCase().padStart(4, '0')}` },
    { name: 'Display', value: m.showing80 ? '80 columns (VDC)' : '40 columns (VIC-IIe)' },
    { name: 'Cassette', value: mem.motorOn ? 'motor on' : 'motor off' },
  ];
  if (mmu.relocated) {
    registers.push({ name: 'Pages 0/1', value: `-> $${hex8(mmu.p0l)}/$${hex8(mmu.p1l)}` });
  }
  return { slots, registers };
}

export class C128FrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;

  constructor(private readonly m: C128Machine) {
    this.panes = {
      memoryMap: () => c128MemoryMap(this.m),
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
