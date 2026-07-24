/**
 * Einstein FrameProbe — keyboard/disk/PSG activity, the two WD1770 drive
 * panel slots, and the OCR text-overlay driver. The Einstein has no cassette
 * transport (its deck is inert) and ticks its own FDC inside runFrame, so
 * there is no frameTick here. See docs/re-architecture.md §3.3/§5 Phase 5.
 */

import type {
  FrameIndicators, FrameProbe, FramePaneProvider, TranscribeDriver,
  MemoryMapSnapshot,
} from '@/machines/machine.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import { parseXtalBasic } from '@/basic/xtal-basic-parser.ts';

/**
 * Build the Einstein memory-layout snapshot. The low 32KB is a ROM read-window
 * toggled by port 0x24: when paged in the CPU reads MOS ROM (0x4000–0x7FFF
 * reads 0xFF beyond the image), but writes always fall through to the 64KB RAM
 * beneath — so each slot shows a CPU-read / CPU-write split like the CPC.
 */
function einsteinMemoryMap(m: EinsteinMachine): MemoryMapSnapshot | null {
  const mem = m.memory;
  const romIn = mem.romPagedIn;
  const romName = m.config.romSizeKB === 8 ? 'MOS ROM' : 'MOS 2.1';

  const ranges = ['C000-FFFF', '8000-BFFF', '4000-7FFF', '0000-3FFF'];
  const slots = [];
  for (let row = 0; row < 4; row++) {
    const slot = 3 - row;
    let read: string;
    if (romIn && slot === 0) read = romName;
    else if (romIn && slot === 1) read = '(0xFF)';
    else read = 'RAM';
    slots.push({ range: ranges[row], read, write: 'RAM' });
  }

  const registers = [
    { name: 'ROM overlay', value: romIn ? 'paged in (port &24)' : 'paged out (port &24)' },
  ];

  return { columns: ['CPU read', 'CPU write'], slots, registers };
}

class EinsteinTranscribeDriver implements TranscribeDriver {
  constructor(private readonly m: EinsteinMachine) {}
  get active(): boolean { return this.m.screenText.active; }
  activate(): void { this.m.screenText.activate(); }
  deactivate(): void { this.m.screenText.deactivate(); }
  run(): { text: string; html: string; grid: OcrGridName } {
    const m = this.m;
    const result = m.ocrScreenStyled();
    if (result.mask.length > 0) {
      m.blankCells(result.mask, result.cols, result.rows, result.paper);
      if (m.display) m.display.updateTexture(m.pixels);
    }
    return result;
  }
}

export class EinsteinFrameProbe implements FrameProbe {
  readonly transcribe: EinsteinTranscribeDriver;
  readonly panes: FramePaneProvider;

  constructor(private readonly m: EinsteinMachine) {
    this.transcribe = new EinsteinTranscribeDriver(m);
    // Xtal BASIC's program text lives in main RAM under any ROM overlay, so we
    // read the underlying RAM (not the paged address space). Pulled on demand
    // by the frame bridge (~1 Hz, only while the pane is open).
    this.panes = {
      memoryMap: () => einsteinMemoryMap(m),
      basicListing: () => parseXtalBasic(m.memory.ramSnapshot()),
    };
  }

  sample(out: FrameIndicators): void {
    const m = this.m;
    const a = m.activity;

    out.keyboard = a.kbdReads;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = 0;
    out.tapeLoad = 0;
    out.beeper = 0;
    out.psg = a.ayWrites > 5 ? 1 : 0;
    out.videoFx = 0;
    out.disk = a.fdcAccesses;
    out.tapeTurbo = false;

    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = true;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = false;

    // Drive A:/B: track/sector readout + LED (WD1770 units 0/1).
    const fdc = m.fdc;
    const active = fdc.currentDrive;
    for (let u = 0; u < 2; u++) {
      if (!fdc.motorOn || u !== active) out.driveLed[u] = 0;
      else if (!fdc.isExecuting) out.driveLed[u] = 1;
      else out.driveLed[u] = fdc.isWriting ? 3 : 2;
      out.driveTrack[u] = fdc.getUnitTrack(u);
      out.driveSector[u] = fdc.isExecuting && u === active ? fdc.currentSector : -1;
      out.driveDirty[u] = fdc.isDirty(u) ? 1 : 0;
    }
    out.driveLed[2] = out.driveLed[3] = -1;

    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyProfile = -1;
  }
}
