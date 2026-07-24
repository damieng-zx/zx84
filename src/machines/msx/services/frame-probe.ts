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
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import { parseMsxBasic, parseMsxBasicVariables } from '@/basic/msx-basic-parser.ts';
import { hex8 } from '@/utils/hex.ts';

/** Label the source paged into one MSX 16KB page given its primary slot number.
 *  slot 0 = internal ROM (BIOS+BASIC, pages 0-1 only), slot 1 = cartridge,
 *  slot 2 = empty, slot 3 = 64KB RAM. */
function msxSlotLabel(slot: number, page: number, hasCart: boolean): { read: string } {
  switch (slot) {
    case 0: return { read: page < 2 ? 'ROM' : '(empty)' };
    case 1: return { read: hasCart ? 'Cartridge' : '(empty)' };
    case 2: return { read: '(empty)' };
    case 3: return { read: 'RAM' };
    default: return { read: '?' };
  }
}

/** Build the MSX memory-layout snapshot: four 16KB pages each selecting one of
 *  four primary slots via the 2-bit fields of PPI port A (0xA8). */
function msxMemoryMap(m: MsxMachine): MemoryMapSnapshot | null {
  const mem = m.memory;
  const primary = mem.getPrimarySlot();
  const hasCart = mem.hasCartridge;
  const ranges = ['0000-3FFF', '4000-7FFF', '8000-BFFF', 'C000-FFFF'];

  const slots = ranges.map((range, page) => {
    const slot = (primary >> (page * 2)) & 3;
    const label = msxSlotLabel(slot, page, hasCart);
    return { range, ...label };
  });

  return {
    slots,
    registers: [{ name: 'Port A8', value: hex8(primary) }],
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
    out.disk = 0;
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

    out.driveLed[0] = out.driveLed[1] = out.driveLed[2] = out.driveLed[3] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyProfile = -1;
  }
}
