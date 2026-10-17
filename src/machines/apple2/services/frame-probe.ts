import type {
  FrameIndicators, FrameProbe, FramePaneProvider, TranscribeDriver,
} from '@/machines/machine.ts';
import { fixedDrive } from '@/media/floppy/floppy-sound.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { APPLE2_ACTIVE_HEIGHT, APPLE2_ACTIVE_WIDTH, APPLE2_BORDER_LEFT, APPLE2_BORDER_TOP } from '../constants.ts';
import type { Apple2Machine } from '../apple2-machine.ts';

/** 5.25" drive (the Disk II's only media). */
const DRIVE = fixedDrive('5.25inch');

class Apple2TranscribeDriver implements TranscribeDriver {
  private _active = false;
  constructor(private readonly m: Apple2Machine) {}
  get active(): boolean { return this._active; }
  activate(): void { this._active = true; }
  deactivate(): void { this._active = false; }

  run() {
    const m = this.m;
    const result = m.ocrScreenStyled();
    if (result.mask.some(Boolean)) {
      m.blankCells(result.mask, result.cols, result.rows, result.paper);
      if (m.display) m.display.updateTexture(m.pixels);
    }
    return {
      text: result.text,
      html: result.html,
      grid: result.grid,
      field: {
        x: APPLE2_BORDER_LEFT, y: APPLE2_BORDER_TOP,
        width: APPLE2_ACTIVE_WIDTH, height: APPLE2_ACTIVE_HEIGHT,
      },
    };
  }
}

export class Apple2FrameProbe implements FrameProbe {
  readonly transcribe: Apple2TranscribeDriver;
  readonly panes: FramePaneProvider = {};

  constructor(private readonly machine: Apple2Machine) {
    this.transcribe = new Apple2TranscribeDriver(machine);
  }

  /** Pure read — overwrite every channel this machine owns, allocating nothing. */
  sample(out: FrameIndicators): void {
    out.keyboard = this.machine.keyboard.anyPressed ? 1 : 0;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = this.machine.cassette.playing ? 1 : 0;
    out.tapeLoad = 0;
    out.beeper = this.machine.activity.beeperToggled ? 1 : 0;
    out.psg = 0;
    out.videoFx = 0;
    out.tapeTurbo = false;
    out.tapeLoaded = this.machine.cassette.loaded;
    out.tapePlaying = this.machine.cassette.playing;
    out.tapePaused = !this.machine.cassette.playing;
    out.tapeFinished = this.machine.cassette.finished;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = false;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;

    const disk = this.machine.disk2;
    const active = disk.motorOn ? disk.currentDriveIndex : -1;
    out.disk = disk.motorOn ? (disk.isWriting ? 3 : disk.isExecuting ? 2 : 1) : 0;
    for (let unit = 0; unit < 2; unit++) {
      const image = disk.getDiskImage(unit);
      out.driveLed[unit] = active === unit ? (disk.isWriting ? 3 : 2) : image ? 1 : 0;
      out.driveTrack[unit] = disk.getUnitTrack(unit);
      out.driveSector[unit] = -1;
      out.driveDirty[unit] = disk.isDirty(unit) ? 1 : 0;
    }
    out.driveLed[2] = out.driveLed[3] = -1;

    out.floppySlot = active >= 0 ? active : -1;
    out.floppyMotor = disk.motorOn;
    out.floppyTrack = active >= 0 ? disk.getUnitTrack(active) : 0;
    out.floppyProfile = DRIVE();
  }

  frameTick(out: FrameIndicators): void {
    out.formattedSlot = -1;
  }

  diskImageForSlot(slot: number): DskImage | null {
    return slot < 2 ? this.machine.disk2.getDiskImage(slot) : null;
  }
}
