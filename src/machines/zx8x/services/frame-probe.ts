import type { FrameIndicators, FramePaneProvider, FrameProbe, TranscribeDriver } from '@/machines/machine.ts';
import type { Zx8xMachine } from '../zx8x-machine.ts';
import { parseZx8xBasicProgram, parseZx8xBasicVariables } from '../basic.ts';

class Zx8xTranscribeDriver implements TranscribeDriver {
  constructor(private readonly machine: Zx8xMachine) {}
  get active(): boolean { return this.machine.screenText.active; }
  activate(): void { this.machine.screenText.activate(); }
  deactivate(): void { this.machine.screenText.deactivate(); }
  run() {
    const result = this.machine.ocrScreenStyled();
    this.machine.blankTextCells(result.mask);
    return result;
  }
}

export class Zx8xFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;
  readonly transcribe: Zx8xTranscribeDriver;

  constructor(private readonly machine: Zx8xMachine) {
    this.transcribe = new Zx8xTranscribeDriver(machine);
    this.panes = {
      basicListing: () => parseZx8xBasicProgram(machine.memory.snapshot(), machine.model),
      basicVars: () => parseZx8xBasicVariables(machine.memory.snapshot(), machine.model),
    };
  }

  sample(out: FrameIndicators): void {
    out.keyboard = this.machine.activity.kbdReads;
    out.joystick = out.mouse = out.tapeIn = out.tapeLoad = 0;
    out.beeper = out.psg = out.videoFx = out.disk = 0;
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
