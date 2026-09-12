/**
 * Ace FrameProbe — keyboard/buzzer activity, the ULA's cassette-port traffic
 * and the pulse-deck transport state. The Ace has no drives or drive sound —
 * those channels stay absent.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe,
  MemoryMapSnapshot, MemoryMapSlot,
} from '@/machines/machine.ts';
import { DRIVE_PROFILE } from '@/media/floppy/floppy-sound.ts';
import type { JupiterAceMachine } from '../ace-machine.ts';

/** The Ace's memory map; the RAM-pack row follows the fitted pack. */
function aceMemoryMap(m: JupiterAceMachine): MemoryMapSnapshot | null {
  const pack = m.memory.ramPackKB;
  const slots: MemoryMapSlot[] = [
    { range: '0000-1FFF', read: 'FORTH ROM' },
    { range: '2000-27FF', read: 'Video RAM', flags: ['screen'] },
    { range: '2800-2FFF', read: 'Char RAM' },
    { range: '3000-3FFF', read: 'Main RAM' },
  ];
  if (pack === 16) slots.push({ range: '4000-7FFF', read: 'RAM pack (16K)' });
  else if (pack === 48) slots.push({ range: '4000-FFFF', read: 'RAM pack (48K)' });
  else slots.push({ range: '4000-FFFF', read: '(expansion)' });
  return { slots, registers: [] };
}

export class AceFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;

  constructor(private readonly m: JupiterAceMachine) {
    this.panes = {
      memoryMap: () => aceMemoryMap(m),
    };
  }

  sample(out: FrameIndicators): void {
    const m = this.m;
    const a = m.activity;

    out.keyboard = a.ulaReads > 0 ? 1 : 0;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = a.earReads;
    out.tapeLoad = a.tapePolls;
    out.beeper = a.beeperToggled ? 1 : 0;
    out.psg = 0;
    out.videoFx = 0;
    out.disk = 0;
    out.tapeTurbo = m.tapeTurboActive;

    const tape = m.tape;
    out.tapeLoaded = tape.loaded;
    out.tapePlaying = tape.playing;
    out.tapePaused = tape.paused;
    out.tapeFinished = tape.finished;
    out.tapePosition = tape.position;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = false;

    out.driveLed[0] = out.driveLed[1] = out.driveLed[2] = out.driveLed[3] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyProfile = DRIVE_PROFILE.keep;
  }
}
