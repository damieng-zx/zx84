import type { FrameIndicators, FrameProbe } from '@/machines/machine.ts';
import type { MtxMachine } from '../mtx-machine.ts';

export class MtxFrameProbe implements FrameProbe {
  constructor(private readonly machine: MtxMachine) {}

  sample(out: FrameIndicators): void {
    out.keyboard = this.machine.activity.kbdReads;
    out.joystick = out.mouse = out.tapeIn = 0;
    out.tapeLoad = this.machine.activity.casReads;
    out.beeper = 0;
    out.psg = this.machine.activity.psgWrites;
    out.videoFx = 0;
    out.disk = this.machine.activity.fdcAccesses;
    out.tapeTurbo = false;
    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = true;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = this.machine.activity.casReads > 0
      ? this.machine.cassette.currentBlock()
      : -1;
    out.fastRomLoading = false;
    out.tracingActive = false;
    const fdc = this.machine.fdc;
    const active = fdc.currentDrive;
    for (let unit = 0; unit < 2; unit++) {
      if (!this.machine.fdx.motorOn || unit !== active) out.driveLed[unit] = 0;
      else if (!fdc.isExecuting) out.driveLed[unit] = 1;
      else out.driveLed[unit] = fdc.isWriting ? 3 : 2;
      out.driveTrack[unit] = fdc.getUnitTrack(unit);
      out.driveSector[unit] = fdc.isExecuting && unit === active ? fdc.currentSector : -1;
      out.driveDirty[unit] = fdc.isDirty(unit) ? 1 : 0;
    }
    out.driveLed[2] = out.driveLed[3] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyProfile = -1;
  }

  diskImageForSlot(slot: number) {
    return slot < 2 ? this.machine.fdc.getDiskImage(slot) : null;
  }
}
