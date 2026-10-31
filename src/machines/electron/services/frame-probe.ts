import type {
  FrameIndicators, FrameProbe, FramePaneProvider, TranscribeDriver,
} from '@/machines/machine.ts';
import { DRIVE_PROFILE } from '@/media/floppy/floppy-sound.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { parseBbcBasic, parseBbcBasicVariables } from '@/basic/bbc-basic-parser.ts';
import type { ElectronMachine } from '../electron-machine.ts';

class ElectronTranscribeDriver implements TranscribeDriver {
  private on = false;
  constructor(private readonly m: ElectronMachine) {}
  get active(): boolean { return this.on; }
  activate(): void { this.on = true; }
  deactivate(): void { this.on = false; }
  run() {
    const m = this.m;
    const result = m.ocrScreenStyled();
    if (result.mask.length > 0) {
      m.blankCells(result.mask, result.cols, result.rows, result.paper);
      if (m.display) m.display.updateTexture(m.pixels);
    }
    const g = m.textLayout();
    return {
      text: result.text, html: result.html, grid: result.grid,
      field: { x: g.x, y: g.y, width: g.cols * g.cellW, height: g.rows * g.cellH },
    };
  }
}

export class ElectronFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;
  readonly transcribe: ElectronTranscribeDriver;

  constructor(private readonly machine: ElectronMachine) {
    this.transcribe = new ElectronTranscribeDriver(machine);
    this.panes = {
      // The tokenised BASIC program lives in main RAM from PAGE (BASIC II, as on the BBC).
      basicListing: () => parseBbcBasic(machine.memory.ram),
      basicVars: () => parseBbcBasicVariables(machine.memory.ram),
    };
  }

  /** Pure read — overwrite every channel this machine owns so no stale value
   *  from a previous frame leaks through. Allocates nothing. */
  sample(out: FrameIndicators): void {
    const m = this.machine;
    const cass = m.cassette;
    out.keyboard = m.keyboard.reads;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = 0;
    out.tapeLoad = cass.running ? 1 : 0;
    out.beeper = m.activity.beeperToggles > 5 ? 1 : 0;
    out.psg = 0;
    out.videoFx = 0;
    const disc = m.plus3Fitted ? m.plus3 : null;
    out.disk = disc && disc.motorOn ? (disc.isExecuting ? 2 : 1) : 0;
    out.tapeTurbo = cass.turboActive;
    out.tapeLoaded = cass.loaded;
    out.tapePlaying = cass.deck.playing;
    out.tapePaused = cass.userPaused;
    out.tapeFinished = cass.deck.finished;
    out.tapePosition = cass.deck.position;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = this.machine.traceActive;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.driveLed[2] = out.driveLed[3] = -1;
    const active = disc ? disc.currentDrive : -1;
    for (let unit = 0; unit < 2; unit++) {
      if (!disc) { out.driveLed[unit] = -1; continue; }
      if (!disc.motorOn || unit !== active) out.driveLed[unit] = 0;
      else out.driveLed[unit] = disc.isExecuting ? (disc.isWriting ? 3 : 2) : 1;
      out.driveTrack[unit] = disc.getUnitTrack(unit);
      out.driveSector[unit] = disc.isExecuting && unit === active ? disc.currentSector : -1;
      out.driveDirty[unit] = disc.isDirty(unit) ? 1 : 0;
    }
    out.floppySlot = disc && active >= 0 && active < 2 ? active : -1;
    out.floppyMotor = disc ? disc.motorOn : false;
    out.floppyTrack = disc ? disc.getUnitTrack(active) : 0;
    out.floppyProfile = DRIVE_PROFILE.keep;
  }

  frameTick(out: FrameIndicators): void {
    this.machine.keyboard.reads = 0;
    const disc = this.machine.plus3Fitted ? this.machine.plus3 : null;
    if (disc && disc.formattedUnit >= 0) {
      out.formattedSlot = disc.formattedUnit;
      disc.formattedUnit = -1;
    }
  }

  diskImageForSlot(slot: number): DskImage | null {
    return slot < 2 && this.machine.plus3Fitted ? this.machine.plus3.getDiskImage(slot) : null;
  }
}
