/**
 * EnterpriseFrameProbe — the status bar's view of the Enterprise: activity
 * counters, tape transport and drive telemetry. The Memory pane's segment
 * layout lives in `inspect.ts` (on demand, may allocate).
 */

import type {
  FrameIndicators, FrameProbe,
} from '@/machines/machine.ts';
import { DRIVE_PROFILE, fixedDrive } from '@/media/floppy/floppy-sound.ts';
import type { EnterpriseMachine } from '../enterprise-machine.ts';

/** The EXDOS card drove 3.5" drives. */
const DRIVE = fixedDrive('3.5inch');

export class EnterpriseFrameProbe implements FrameProbe {
  constructor(private readonly machine: EnterpriseMachine) {}

  sample(out: FrameIndicators): void {
    const m = this.machine;
    out.keyboard = m.activity.kbdReads;
    out.joystick = out.mouse = out.tapeIn = 0;
    out.tapeLoad = m.activity.fileAccesses;
    out.beeper = 0;
    out.psg = m.dave.level > 0.004 ? 1 : 0;
    out.videoFx = 0;
    out.disk = m.activity.fdcAccesses;
    out.tapeTurbo = false;
    out.tapeLoaded = false;
    out.tapePlaying = out.tapePaused = out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = this.machine.traceActive;

    const card = m.exdos;
    for (let unit = 0; unit < 4; unit++) {
      if (!card) { out.driveLed[unit] = -1; continue; }
      const fdc = card.fdc;
      if (!fdc.motorOn || unit !== fdc.currentDrive) out.driveLed[unit] = 0;
      else if (!fdc.isExecuting) out.driveLed[unit] = 1;
      else out.driveLed[unit] = fdc.isWriting ? 3 : 2;
      out.driveTrack[unit] = fdc.getUnitTrack(unit);
      out.driveSector[unit] = fdc.isExecuting && unit === fdc.currentDrive ? fdc.currentSector : -1;
      out.driveDirty[unit] = fdc.isDirty(unit) ? 1 : 0;
    }
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    if (card) {
      out.floppySlot = card.fdc.currentDrive;
      out.floppyMotor = card.fdc.motorOn;
      out.floppyTrack = card.fdc.currentTrack;
      out.floppyProfile = DRIVE();
    } else {
      out.floppySlot = -1;
      out.floppyProfile = DRIVE_PROFILE.keep;
    }
  }

  frameTick(out: FrameIndicators): void {
    const fdc = this.machine.exdos?.fdc;
    if (fdc && fdc.formattedUnit >= 0) {
      out.formattedSlot = fdc.formattedUnit;
      fdc.formattedUnit = -1;
    }
  }

  diskImageForSlot(slot: number) {
    return this.machine.exdos?.fdc.getDiskImage(slot) ?? null;
  }
}
