/**
 * NewBrain FrameProbe — keyboard scanning, cassette-port traffic and the deck
 * transport state. No drives, mice or sound.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSnapshot,
} from '@/machines/machine.ts';
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

export class NewBrainFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;

  constructor(private readonly m: NewBrainMachine) {
    this.panes = { memoryMap: () => newBrainMemoryMap(m) };
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
