/**
 * CPC FrameProbe — maps the CPC's per-frame activity counters and cassette
 * transport onto the generic FrameIndicators channels, and hosts the CPC's
 * pull-on-demand debug panes (memory layout, Locomotive BASIC) and the OCR
 * text-overlay driver. See docs/re-architecture.md §3.3/§5 Phase 5.
 *
 * The CPC never drove the A..D drive-status panel slots or the drive-sound
 * synth from the frame bridge, so this probe leaves those channels absent —
 * matching the pre-probe behaviour exactly.
 */

import type {
  FrameIndicators, FrameProbe, FramePaneProvider, TranscribeDriver,
  MemoryMapSnapshot,
} from '@/machines/machine.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import { parseLocomotiveBasic, parseLocomotiveVariables } from '@/basic/cpc-basic-parser.ts';
import { hex16 } from '@/utils/hex.ts';

/**
 * Build the CPC memory-layout snapshot. Unlike the Spectrum (a flat 64KB view),
 * the CPC overlays ROM on RAM with write fall-through, so each Z80 slot is shown
 * as a CPU-*read* source (ROM or RAM) and the RAM bank the CPU *writes* beneath
 * it. The footer decodes the RAM configuration, the selected/enabled ROMs, the
 * video DMA the CRTC sees, and the Gate-Array screen mode.
 */
function cpcMemoryMap(cpc: CpcMachine): MemoryMapSnapshot | null {
  const mem = cpc.memory;
  const p = mem.pagingState();

  // Name the upper ROM at &C000: 0 = BASIC, 7 = AMSDOS, others = expansion ROM.
  const upperName = (idx: number): string => {
    if (idx === 0) return 'BASIC';
    if (idx === 7) return 'AMSDOS';
    return `ROM ${idx}`;
  };

  // Which RAM bank the CRTC fetches from: the screen's CPU base is derived from
  // the 14-bit MA (R12/R13); its top two bits select one of the base-64K banks.
  const dispStart = cpc.crtc.displayStart;
  const screenBase = (dispStart & 0x3000) << 2;     // CPU address (0/4/8/C × 0x4000)
  const screenSlot = (screenBase >>> 14) & 3;
  const screenBank = screenSlot;                    // video DMA = base 64K, banks 0–3

  // One row per 16KB slot, high to low.
  const ranges = ['C000-FFFF', '8000-BFFF', '4000-7FFF', '0000-3FFF'];
  const slots = [];
  for (let row = 0; row < 4; row++) {
    const slot = 3 - row;
    let read: string;
    if (slot === 0 && p.lowerRomEnabled) {
      read = 'OS Rom';
    } else if (slot === 3 && p.upperRomEnabled) {
      const absent = mem.getUpperRom(p.selectedUpperRom) === undefined;
      read = absent ? `${upperName(p.selectedUpperRom)}!` : upperName(p.selectedUpperRom);
    } else {
      read = `RAM ${p.slotBanks[slot]}`;
    }
    const flags = slot === screenSlot ? ['screen' as const] : undefined;
    slots.push({ range: ranges[row], read, write: `RAM ${p.slotBanks[slot]}`, flags });
  }

  const registers = [
    { name: 'RAM config', value: `${p.ramConfig} → [${p.slotBanks.join(' ')}]  64K blk ${p.ram64kBlock}` },
    { name: 'Upper ROM', value: `${p.selectedUpperRom} ${upperName(p.selectedUpperRom)}  Low ${p.lowerRomEnabled ? 'on' : 'off'}  High ${p.upperRomEnabled ? 'on' : 'off'}` },
    { name: 'Video DMA', value: `bank ${screenBank}  base &${hex16(screenBase)}` },
    { name: 'Gate Array', value: `mode ${cpc.gateArray.mode}` },
  ];

  return { columns: ['CPU read', 'CPU write'], slots, registers };
}

class CpcTranscribeDriver implements TranscribeDriver {
  constructor(private readonly c: CpcMachine) {}
  get active(): boolean { return this.c.screenText.active; }
  activate(): void { this.c.screenText.activate(); }
  deactivate(): void { this.c.screenText.deactivate(); }
  run(): { text: string; html: string; grid: OcrGridName } {
    const c = this.c;
    const result = c.ocrScreenStyled();
    if (result.mask.length > 0) {
      c.blankCells(result.mask, result.cols, result.rows, result.paper);
      if (c.display) c.display.updateTexture(c.pixels);
    }
    return result;
  }
}

export class CpcFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;
  readonly transcribe: CpcTranscribeDriver;

  constructor(private readonly c: CpcMachine) {
    const cpc = c;
    this.transcribe = new CpcTranscribeDriver(c);
    this.panes = {
      memoryMap: () => cpcMemoryMap(cpc),
      // The Locomotive BASIC program lives at &0170 under the OS ROM overlay.
      basicListing: () => parseLocomotiveBasic(cpc.memory.ramSnapshot()),
      basicVars: () => parseLocomotiveVariables(cpc.memory.ramSnapshot()),
    };
  }

  sample(out: FrameIndicators): void {
    const c = this.c;
    const a = c.activity;
    const tape = c.tape;

    out.keyboard = a.kbdReads;
    out.joystick = 0;
    out.mouse = a.mouseReads > 0 || (c.amxMouse.enabled && c.amxMouse.active) ? 1 : 0;
    out.tapeIn = 0;
    out.tapeLoad = a.tapeReads;
    out.beeper = 0;
    out.psg = a.ayWrites > 5 ? 1 : 0;
    out.videoFx = 0;
    out.disk = a.fdcAccesses;
    out.tapeTurbo = false;

    out.tapeLoaded = tape.loaded;
    out.tapePlaying = tape.playing;
    out.tapePaused = tape.paused;
    out.tapeFinished = tape.finished;
    out.tapePosition = tape.position;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = false;

    out.driveLed[0] = out.driveLed[1] = out.driveLed[2] = out.driveLed[3] = -1;
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyProfile = -1;
  }

  frameTick(): void {
    const c = this.c;
    // Auto-rewind: the tape just ran out → rewind, paused, ready to replay.
    if (c.tapeAutoRewind && c.tape.loaded && !c.tape.playing && c.tape.finished) {
      c.tape.position = 0;
      c.tape.paused = true;
      c.tape.startPlayback();
    }
  }
}
