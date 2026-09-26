import type { FrameIndicators, FrameProbe } from '@/machines/machine.ts';
import { fixedDrive } from '@/media/floppy/floppy-sound.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { BbcMachine } from '../bbc-machine.ts';

/** BBC DFS drives are 3.5" 80-track units (an SSD is 80 tracks). */
const DRIVE = fixedDrive('3.5inch');

export class BbcFrameProbe implements FrameProbe {
  constructor(private readonly machine: BbcMachine) {}

  /** Pure read — overwrite every channel this machine owns so no stale value
   *  from a previous frame leaks through. Allocates nothing. */
  sample(out: FrameIndicators): void {
    out.keyboard = 0;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = 0;
    out.tapeLoad = 0;
    out.beeper = 0;
    out.psg = this.machine.activity.psgWrites;
    out.videoFx = 0;
    out.tapeTurbo = false;
    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = true;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = false;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;

    const fdc = this.machine.fdc1770.fdc;
    out.disk = fdc.motorOn ? (fdc.isExecuting ? 2 : 1) : 0;
    const active = fdc.currentDrive;
    for (let unit = 0; unit < 2; unit++) {
      if (!fdc.motorOn || unit !== active) out.driveLed[unit] = 0;
      else out.driveLed[unit] = fdc.isExecuting ? (fdc.isWriting ? 3 : 2) : 1;
      out.driveTrack[unit] = fdc.getUnitTrack(unit);
      out.driveSector[unit] = fdc.isExecuting && unit === active ? fdc.currentSector : -1;
      out.driveDirty[unit] = fdc.isDirty(unit) ? 1 : 0;
    }
    out.driveLed[2] = out.driveLed[3] = -1;

    out.floppySlot = active < 2 ? active : -1;
    out.floppyMotor = fdc.motorOn;
    out.floppyTrack = fdc.getUnitTrack(active);
    out.floppyProfile = DRIVE();
  }

  frameTick(out: FrameIndicators): void {
    const fdc = this.machine.fdc1770.fdc;
    if (fdc.formattedUnit >= 0) {
      out.formattedSlot = fdc.formattedUnit;
      fdc.formattedUnit = -1;
    }
  }

  diskImageForSlot(slot: number): DskImage | null {
    return slot < 2 ? this.machine.fdc1770.getDiskImage(slot) : null;
  }
}
