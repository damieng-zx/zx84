/**
 * Atari 400/800/XL frame probe: status LEDs and drive indicators.
 *
 * `sample()` runs every rAF and must not allocate; it copies the machine's
 * frame-scoped counters and the drives' last-access state. `frameTick()` then
 * clears the drives' momentary motor/activity flags. The Memory layout pane and
 * the BASIC panes are pull-on-demand and live in `inspect.ts`.
 */

import type {
  FrameIndicators, FrameProbe, TranscribeDriver,
} from '@/machines/machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { AtariMachine } from '../atari-machine.ts';

/** The 400/800 shipped with 5.25" drives; the floppy-sound synth profile is 2. */
const DRIVE_PROFILE_5_25 = 2;

/** TEXT overlay: OCR the standard text grid, then blank what it read. */
class AtariTranscribeDriver implements TranscribeDriver {
  constructor(private readonly m: AtariMachine) {}
  get active(): boolean { return this.m.transcribing; }
  activate(): void { this.m.transcribing = true; }
  deactivate(): void { this.m.transcribing = false; }
  run(): { text: string; html: string; grid: OcrGridName } {
    const m = this.m;
    const result = m.ocrScreenStyled();
    if (result.mask.some(Boolean)) {
      m.blankCells(result.mask, result.cols, result.rows);
      if (m.display) m.display.updateTexture(m.pixels);
    }
    return result;
  }
}

export class AtariFrameProbe implements FrameProbe {
  readonly transcribe: AtariTranscribeDriver;

  constructor(private readonly m: AtariMachine) {
    this.transcribe = new AtariTranscribeDriver(m);
  }

  sample(out: FrameIndicators): void {
    out.keyboard = this.m.activity.keyPresses;
    out.psg = this.m.activity.psgWrites;
    // Activity, not level: the OS leaves CONSOL bit 3 high at rest, so only
    // a frame in which the speaker moved (a key click, a beep) lights BEEP.
    out.beeper = this.m.activity.speakerToggles > 0 ? 1 : 0;

    // The program recorder has no transport buttons of its own: the computer
    // starts and stops it through the motor line, as with PLAY held down. So
    // the pane shows it playing while a load is under way and never paused,
    // and highlights the file SIO is reading.
    const casReads = this.m.activity.casReads;
    const loading = this.m.tapeLoadingActive;
    out.tapeIn = 0;
    out.tapeLoad = casReads;
    out.tapeTurbo = this.m.tapeTurbo && loading;
    out.tapeLoaded = this.m.cassette.loaded;
    out.tapePlaying = loading;
    out.tapePaused = false;
    out.tapeFinished = this.m.cassette.loaded && this.m.cassette.finished;
    out.tapePosition = 0;
    out.casBlock = casReads > 0 ? this.m.cassette.currentFile() : -1;
    out.tracingActive = this.m.traceActive;

    const drives = this.m.services.disks.states;
    // The pane has four slots; the ones with no drive fitted read as absent.
    for (let slot = drives.length; slot < out.driveLed.length; slot++) {
      out.driveLed[slot] = -1;
      out.driveSector[slot] = -1;
      out.driveTrack[slot] = 0;
      out.driveDirty[slot] = 0;
    }
    let activeSlot = -1;
    for (let slot = 0; slot < drives.length; slot++) {
      const d = drives[slot];
      out.driveLed[slot] = d.disk ? (d.activity !== 0 ? d.activity : 1) : -1;
      out.driveTrack[slot] = d.track;
      out.driveSector[slot] = d.disk ? d.sector : -1;
      out.driveDirty[slot] = d.dirty ? 1 : 0;
      if (d.motorOn) activeSlot = slot;
    }
    out.disk = activeSlot >= 0 ? 1 : 0;
    if (activeSlot >= 0) {
      const d = drives[activeSlot];
      out.floppySlot = activeSlot;
      out.floppyMotor = true;
      out.floppyTrack = d.track;
      out.floppyProfile = DRIVE_PROFILE_5_25;
    } else {
      out.floppySlot = -1;
      out.floppyMotor = false;
      out.floppyProfile = -1;
    }
  }

  frameTick(_out: FrameIndicators): void {
    this.m.services.disks.clearActivity();
  }

  diskImageForSlot(slot: number): DskImage | null {
    return this.m.services.disks.diskImageForSlot(slot);
  }
}
