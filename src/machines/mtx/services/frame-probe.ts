import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSnapshot, TranscribeDriver,
} from '@/machines/machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import { parseMtxBasic } from '@/basic/mtx-basic-parser.ts';
import type { MtxMachine } from '../mtx-machine.ts';
import { hex8 } from '@/utils/hex.ts';

/** Friendly name for an MTX switchable ROM page index. Pages 2,3,6,7 are
 *  normally empty (0xFF); page 2 is the ROM-pack (cartridge) slot. */
function mtxRomPageName(page: number, hasCart: boolean): string {
  if (page === 0) return 'BASIC ROM';
  if (page === 1) return 'Assembler ROM';
  if (page === 4) return 'CP/M ROM';
  if (page === 5) return 'FDX ROM';
  if (page === 2 && hasCart) return 'Cartridge';
  return `(empty ${page})`;
}

/** Build the MTX memory-layout snapshot.
 *
 *  The MTX address space is unlike the Spectrum/CPC 4×16KB grid: an 8K OS ROM
 *  at 0x0000, an 8K switchable ROM page at 0x2000, paged RAM 0x4000-0xBFFF, and
 *  a common 16K RAM block at 0xC000. In CP/M (all-RAM) mode the ROMs are
 *  replaced by RAM throughout. */
function mtxMemoryMap(m: MtxMachine): MemoryMapSnapshot | null {
  const mem = m.memory;
  const ramMode = mem.ramMode;
  const romPage = mem.selectedRomPage;
  const hasCart = mem.romPackSizeBytes > 0;

  const slots = [
    {
      range: 'C000-FFFF',
      read: 'RAM (common)',
    },
    {
      range: '4000-BFFF',
      read: `RAM page ${mem.selectedRamPage}`,
    },
    {
      range: '2000-3FFF',
      read: ramMode ? 'RAM' : mtxRomPageName(romPage, hasCart),
    },
    {
      range: '0000-1FFF',
      read: ramMode ? 'RAM' : 'OS ROM',
    },
  ];

  const ramKb = Math.round(mem.ramSizeBytes / 1024);
  const registers = [
    { name: 'IOBYTE', value: hex8(mem.pageRegister) },
    { name: 'ROM page', value: String(romPage) },
    { name: 'RAM page', value: String(mem.selectedRamPage) },
    { name: 'Mode', value: ramMode ? 'CP/M (all-RAM)' : 'ROM' },
    { name: 'RAM', value: `${ramKb}K${mem.ramExpansion512kEnabled ? ' +512K' : ''}` },
  ];

  return { slots, registers };
}

/** TEXT-overlay driver: OCRs the VDP screen, blanks the matched cells, and
 *  returns the crisp text/HTML. The FDX 80-column board already renders sharp
 *  text, so nothing is transcribed while it is showing. */
class MtxTranscribeDriver implements TranscribeDriver {
  constructor(private readonly m: MtxMachine) {}
  get active(): boolean { return this.m.screenText.active; }
  activate(): void { this.m.screenText.activate(); }
  deactivate(): void { this.m.screenText.deactivate(); }
  run(): { text: string; html: string; grid: OcrGridName } {
    const m = this.m;
    if (m.column80.enabled) return { text: '', html: '', grid: '32x24' };
    const result = m.ocrScreenStyled();
    if (result.mask.length > 0) {
      m.blankCells(result.mask, result.cols, result.rows, result.paper);
      if (m.display) m.display.updateTexture(m.pixels);
    }
    return result;
  }
}

export class MtxFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;
  readonly transcribe: MtxTranscribeDriver;

  constructor(private readonly machine: MtxMachine) {
    this.panes = {
      memoryMap: () => mtxMemoryMap(this.machine),
      // The BASIC program sits at CPU 0x4000; snapshot() gives the flat CPU view.
      basicListing: () => parseMtxBasic(machine.memory.snapshot()),
    };
    this.transcribe = new MtxTranscribeDriver(machine);
  }

  sample(out: FrameIndicators): void {
    out.keyboard = this.machine.activity.kbdReads;
    out.joystick = out.mouse = out.tapeIn = 0;
    out.tapeLoad = this.machine.activity.casReads;
    out.beeper = 0;
    out.psg = this.machine.activity.psgWrites;
    out.videoFx = 0;
    out.disk = this.machine.activity.fdcAccesses;
    out.tapeTurbo = false;
    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = true;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = this.machine.activity.casReads > 0
      ? this.machine.cassette.currentBlock()
      : -1;
    out.fastRomLoading = false;
    out.tracingActive = false;
    const fdc = this.machine.fdc;
    const active = fdc.currentDrive;
    for (let unit = 0; unit < 2; unit++) {
      if (!this.machine.fdx.motorOn || unit !== active) out.driveLed[unit] = 0;
      else if (!fdc.isExecuting) out.driveLed[unit] = 1;
      else out.driveLed[unit] = fdc.isWriting ? 3 : 2;
      out.driveTrack[unit] = fdc.getUnitTrack(unit);
      out.driveSector[unit] = fdc.isExecuting && unit === active ? fdc.currentSector : -1;
      out.driveDirty[unit] = fdc.isDirty(unit) ? 1 : 0;
    }
    out.driveLed[2] = out.driveLed[3] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyProfile = -1;
  }

  diskImageForSlot(slot: number) {
    return slot < 2 ? this.machine.fdc.getDiskImage(slot) : null;
  }
}
