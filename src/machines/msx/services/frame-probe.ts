/**
 * MSX FrameProbe — keyboard/PSG/cassette-read activity and the instant-load
 * cassette's current-block highlight, plus the OCR text-overlay driver. The
 * MSX has no pulse tape transport, drives, or drive sound — those channels
 * stay absent, matching the pre-probe frame-bridge body exactly.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, TranscribeDriver,
  MemoryMapSnapshot,
} from '@/machines/machine.ts';
import { DRIVE_PROFILE, fixedDrive } from '@/media/floppy/floppy-sound.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import { parseMsxBasic, parseMsxBasicVariables } from '@/basic/msx-basic-parser.ts';
import { hex8 } from '@/utils/hex.ts';

/** The disk interface's drives are 3.5" units. */
const DRIVE = fixedDrive('3.5inch');

/** Label the source paged into one MSX 16KB page given its primary slot number.
 *  slot 0 = internal ROM (BIOS+BASIC, pages 0-1 only), slot 1 = cartridge,
 *  slot 2 = 64KB RAM, slot 3 = rear expansion connector (the floppy disk
 *  interface's Disk BASIC ROM in page 1 when fitted, else empty). */
function msxSlotLabel(slot: number, page: number, cartHere: boolean, diskHere: boolean): { read: string } {
  switch (slot) {
    case 0: return { read: page < 2 ? 'ROM' : '(empty)' };
    case 1: return { read: cartHere ? 'Cartridge' : '(empty)' };
    case 2: return { read: 'RAM' };
    case 3: return { read: page === 1 && diskHere ? 'Disk ROM' : '(empty)' };
    default: return { read: '?' };
  }
}

/** Build the MSX memory-layout snapshot: four 16KB pages each selecting one of
 *  four primary slots via the 2-bit fields of PPI port A (0xA8). */
function msxMemoryMap(m: MsxMachine): MemoryMapSnapshot | null {
  const mem = m.memory;
  const primary = mem.getPrimarySlot();
  const ranges = ['0000-3FFF', '4000-7FFF', '8000-BFFF', 'C000-FFFF'];

  const slots = ranges.map((range, page) => {
    const slot = (primary >> (page * 2)) & 3;
    const label = msxSlotLabel(slot, page, mem.cartCoversPage(page), mem.hasDiskInterface);
    return { range, ...label };
  });

  return {
    slots,
    registers: mem.cartridgeMapper === 'plain'
      ? [{ name: 'Port A8', value: hex8(primary) }]
      : [{ name: 'Port A8', value: hex8(primary) }, { name: 'Mapper', value: mem.cartridgeMapper }],
  };
}

class MsxTranscribeDriver implements TranscribeDriver {
  constructor(private readonly m: MsxMachine) {}
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

export class MsxFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;
  readonly transcribe: MsxTranscribeDriver;

  constructor(private readonly m: MsxMachine) {
    this.transcribe = new MsxTranscribeDriver(m);
    this.panes = {
      memoryMap: () => msxMemoryMap(m),
      // MSX BASIC's program and variable tables live in the physical RAM slot.
      basicListing: () => parseMsxBasic(m.memory.ramSnapshot()),
      basicVars: () => parseMsxBasicVariables(m.memory.ramSnapshot()),
    };
  }

  sample(out: FrameIndicators): void {
    const m = this.m;
    const a = m.activity;

    out.keyboard = a.kbdReads;
    out.joystick = 0;
    out.mouse = 0;
    out.tapeIn = 0;
    out.tapeLoad = a.casReads;
    out.beeper = 0;
    out.psg = a.ayWrites > 5 ? 1 : 0;
    out.videoFx = 0;
    out.disk = a.fdcAccesses;
    out.tapeTurbo = false;

    // The MSX cassette is instant-load: no transport sync, only the
    // currently-read block highlight while CLOAD/BLOAD sweeps through.
    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = true;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = a.casReads > 0 ? m.cassette.currentBlock() : -1;
    out.fastRomLoading = false;
    out.tracingActive = false;

    out.driveLed[2] = out.driveLed[3] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;

    const fitted = m.floppyEnabled && m.diskIf.romLoaded;
    if (!fitted) {
      out.driveLed[0] = out.driveLed[1] = -1;
      out.floppySlot = -1;
      out.floppyProfile = DRIVE_PROFILE.keep;
      return;
    }
    const fdc = m.fdc;
    const active = m.diskIf.selectedDrive;
    for (let unit = 0; unit < 2; unit++) {
      if (!m.diskIf.motorOn || unit !== active) out.driveLed[unit] = 0;
      else if (!fdc.isExecuting) out.driveLed[unit] = 1;
      else out.driveLed[unit] = fdc.isWriting ? 3 : 2;
      out.driveTrack[unit] = fdc.getUnitTrack(unit);
      out.driveSector[unit] = fdc.isExecuting && unit === active ? fdc.currentSector : -1;
      out.driveDirty[unit] = fdc.isDirty(unit) ? 1 : 0;
    }
    out.floppySlot = active;
    out.floppyMotor = m.diskIf.motorOn;
    out.floppyTrack = fdc.getUnitTrack(active);
    out.floppyProfile = DRIVE();
  }

  /** The interface ticks its own controller from runFrame, so the only per-UI-
   *  frame bookkeeping left is consuming the format latch: a completed WRITE
   *  TRACK re-detects the disk's metadata through the bridge. */
  frameTick(out: FrameIndicators): void {
    const fdc = this.m.fdc;
    if (fdc.formattedUnit >= 0) {
      out.formattedSlot = fdc.formattedUnit;
      fdc.formattedUnit = -1;
    }
  }

  diskImageForSlot(slot: number) {
    return slot < 2 ? this.m.fdc.getDiskImage(slot) : null;
  }
}
