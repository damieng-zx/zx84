import type { FrameIndicators, FrameProbe } from '@/machines/machine.ts';
import type { MtxMachine } from '../mtx-machine.ts';

export class MtxFrameProbe implements FrameProbe {
  constructor(private readonly machine: MtxMachine) {}

  sample(out: FrameIndicators): void {
    out.keyboard = this.machine.activity.kbdReads;
    out.joystick = out.mouse = out.tapeIn = out.tapeLoad = 0;
    out.beeper = 0;
    out.psg = this.machine.activity.psgWrites;
    out.videoFx = out.disk = 0;
    out.tapeTurbo = false;
    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = true;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = false;
    out.driveLed[0] = out.driveLed[1] = out.driveLed[2] = out.driveLed[3] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyProfile = -1;
  }
}
