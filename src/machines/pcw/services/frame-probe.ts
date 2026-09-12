/**
 * PCW FrameProbe — per-frame activity onto the generic indicator channels, plus
 * the memory-layout pane.
 *
 * `sample()` is a tier-3 hot path: it overwrites the shared struct in place and
 * must not allocate. `panes.memoryMap()` is pull-on-demand and may allocate.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSlot, MemoryMapSnapshot,
  TranscribeDriver,
} from '@/machines/machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { hex8 } from '@/utils/hex.ts';
import type { PcwMachine } from '../pcw-machine.ts';
import { PCW_KEYBOARD_BLOCK } from '../constants.ts';

/** Build the PCW memory-layout snapshot. Reads and writes can address
 *  different physical blocks (ports &F0-&F3 bit 7 clear), so both are shown. */
function pcwMemoryMap(m: PcwMachine): MemoryMapSnapshot {
  const p = m.memory.pagingState();
  const ranges = ['C000-FFFF', '8000-BFFF', '4000-7FFF', '0000-3FFF'];
  const rollerBlock = m.asic.rollerAddress >>> 14;

  const slots: MemoryMapSlot[] = ranges.map((range, row) => {
    const index = 3 - row;
    const src = p.blocks[index];
    const read = `Block ${src.read}`;
    const write = `Block ${src.write}`;
    const flags: ('screen' | 'active')[] = [];
    // The display fetch reads physical blocks directly and ignores CPU paging,
    // so a block is flagged only when the roller RAM actually points into it.
    if (src.read === rollerBlock) flags.push('screen');
    if (src.read === PCW_KEYBOARD_BLOCK) flags.push('active');
    return { range, read, write, flags: flags.length ? flags : undefined };
  });

  return {
    columns: ['CPU read', 'CPU write'],
    slots,
    registers: [
      { name: 'F0', value: hex8(p.banks[0]) },
      { name: 'F1', value: hex8(p.banks[1]) },
      { name: 'F2', value: hex8(p.banks[2]) },
      { name: 'F3', value: hex8(p.banks[3]) },
      { name: 'F4', value: hex8(p.memctl) },
      { name: 'Roller', value: hex8(m.asic.rollerBase) },
      { name: 'Booted', value: m.booted ? 'Y' : 'N' },
    ],
  };
}

/**
 * TEXT-overlay driver.
 *
 * Nothing to set up: the PCW's transcription re-reads the bitmap every frame,
 * so the flag only records whether the bridge still owes us a deactivate.
 */
class PcwTranscribeDriver implements TranscribeDriver {
  private on = false;
  constructor(private readonly m: PcwMachine) {}

  get active(): boolean { return this.on; }
  activate(): void { this.on = true; }

  deactivate(): void {
    this.on = false;
    // The blanked cells were painted into the frame buffer, so the picture
    // underneath only returns once the ASIC redraws it.
    this.m.requestRedraw();
  }

  run(): { text: string; html: string; grid: OcrGridName } {
    const result = this.m.ocrScreenStyled();
    if (result.cells) {
      this.m.blankTextCells(result.cells);
      this.m.display?.updateTexture(this.m.pixels);
    }
    return { text: result.text, html: result.html, grid: result.grid };
  }
}

export class PcwFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;
  readonly transcribe: PcwTranscribeDriver;

  constructor(private readonly m: PcwMachine) {
    this.transcribe = new PcwTranscribeDriver(m);
    this.panes = { memoryMap: () => pcwMemoryMap(m) };
  }

  sample(out: FrameIndicators): void {
    const m = this.m;
    const a = m.activity;

    out.keyboard = a.kbdReads;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = 0;
    out.tapeLoad = 0;
    out.beeper = a.beeperWrites;
    out.psg = 0;
    out.videoFx = 0;
    out.disk = a.fdcAccesses;
    out.tapeTurbo = false;

    // No cassette hardware at all, so every tape channel reports idle.
    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = false;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = false;

    const fdc = m.fdc;
    const fitted = m.config.drives;
    const activeUnit = fdc.motorOn ? fdc.currentUnit & 1 : -1;
    let soundSlot = -1;
    for (let u = 0; u < 4; u++) {
      if (u >= fitted) { out.driveLed[u] = -1; continue; }
      const motor = activeUnit === u;
      out.driveLed[u] = !motor ? 0
        : fdc.isWriting ? 3
        : fdc.isExecuting ? 2
        : 1;
      out.driveTrack[u] = fdc.getUnitTrack(u);
      out.driveSector[u] = fdc.currentSector;
      out.driveDirty[u] = fdc.isDirty(u) ? 1 : 0;
      if (motor && soundSlot < 0) soundSlot = u;
    }

    out.mdvCount = 0;
    out.mdvMotorMask = 0;

    // Drive-sound feed: the PCW's drives are 3" CF2 (profile 0), the same
    // mechanism as the +3's.
    out.floppySlot = soundSlot;
    out.floppyMotor = soundSlot >= 0;
    out.floppyTrack = soundSlot >= 0 ? fdc.getUnitTrack(soundSlot) : 0;
    out.floppyProfile = 0;
  }

  frameTick(): void {
    this.m.fdc.tickFrame();
  }

  diskImageForSlot(slot: number): DskImage | null {
    return slot < this.m.config.drives ? this.m.fdc.getDiskImage(slot) : null;
  }
}
