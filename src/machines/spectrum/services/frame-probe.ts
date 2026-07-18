/**
 * Spectrum FrameProbe — maps the machine's per-frame activity counters,
 * transport state, and drive telemetry onto the generic FrameIndicators
 * channels (docs/re-architecture.md §3.3/§5 Phase 5).
 *
 * `sample()` is a pure read on the hot once-per-rAF path: no allocation, no
 * machine mutation. Device bookkeeping that must run once per *UI* frame
 * (FDC frame ticks, format/SCAN latch consumption, tape auto-rewind) lives in
 * `frameTick()`, which the bridge calls at its signal-batch cadence — throttled
 * under turbo, exactly like the pre-probe frame-bridge body.
 */

import type {
  FrameIndicators, FrameProbe, FramePaneProvider, TranscribeDriver,
} from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { WD179x } from '@/cores/wd179x.ts';
import type { UPD765A } from '@/cores/upd765a.ts';
import type { FontSource, OcrGridName } from '@/ocr/spectrum.ts';
import { isPlus2AClass } from '@/machines/spectrum/models.ts';
import { parseBasicProgram, parseBasicVariables } from '@/basic/sinclair-basic-parser';
import { hex8 } from '@/utils/hex.ts';

/** Compute a drive-panel slot's LED state: 0 off, 1 motor, 2 read, 3 write.
 *  Mirrors the old frame-bridge renderDriveStatus() decision tree. */
function driveLed(fdc: UPD765A | WD179x, unit: number, activeUnit: number): number {
  if (!fdc.motorOn || unit !== activeUnit) return 0;
  if (!fdc.isExecuting) return 1;
  return fdc.isWriting ? 3 : 2;
}

/** Fill one A..D panel slot from an FDC unit. Sector shows only while the
 *  active unit is executing (else -1 → '--'), as before. */
function fillDriveSlot(out: FrameIndicators, slot: number, fdc: UPD765A | WD179x, unit: number, activeUnit: number): void {
  out.driveLed[slot] = driveLed(fdc, unit, activeUnit);
  out.driveTrack[slot] = fdc.getUnitTrack(unit);
  out.driveSector[slot] = fdc.isExecuting && unit === activeUnit ? fdc.currentSector : -1;
  out.driveDirty[slot] = fdc.isDirty(unit) ? 1 : 0;
}

/** The WD-family interface currently wired to panel slots C/D: the +D, else
 *  the Beta Disk (mutually exclusive), else null. */
function activeWd(s: Spectrum): WD179x | null {
  return s.mgtPlusD.enabled ? s.mgtPlusD.fdc : s.betaDisk.enabled ? s.betaDisk.fdc : null;
}

/** Render the Spectrum memory-layout pane (moved verbatim from frame-bridge). */
function renderBanks(s: Spectrum): string {
  const mem = s.memory;
  const n = '<span class="reg-name">';
  const e = '</span>';
  const plus2a = isPlus2AClass(s.model);

  const region = (addr: string, label: string) => `${n}${addr}${e} ${label}`;
  const lines: string[] = [];

  if (plus2a && mem.specialPaging) {
    // Special paging mode - all RAM
    const mode = (mem.port1FFD >> 1) & 3;
    const configs = [
      ['0', '1', '2', '3'],
      ['4', '5', '6', '7'],
      ['4', '5', '6', '3'],
      ['4', '7', '6', '3'],
    ];
    const [b0, b1, b2, b3] = configs[mode];
    lines.push(
      region('C000-FFFF', `RAM Bank ${b3}`),
      region('8000-BFFF', `RAM Bank ${b2}`),
      region('4000-7FFF', `RAM Bank ${b1}`),
      region('0000-3FFF', `RAM Bank ${b0}`),
    );
  } else {
    const romNum = mem.currentROM;
    const romLabel = plus2a
      ? `ROM Page ${romNum}`
      : romNum === 0 ? '128K Editor ROM' : '48K BASIC ROM';

    const screenBank = (mem.port7FFD & 0x08) ? 7 : 5;
    const isScreenPage = (bank: number) => bank === screenBank;

    lines.push(
      region('C000-FFFF', `RAM Bank ${mem.currentBank}${isScreenPage(mem.currentBank) ? ' (Screen)' : ''}`),
      region('8000-BFFF', `RAM Bank 2`),
      region('4000-7FFF', `RAM Bank 5${isScreenPage(5) ? ' (Screen)' : ''}`),
      region('0000-3FFF', romLabel),
    );
  }

  let portLine = `${n}7FFD${e} ${hex8(mem.port7FFD)}`;
  if (plus2a) portLine += `  ${n}1FFD${e} ${hex8(mem.port1FFD)}`;
  portLine += `  ${n}Lock${e} ${mem.pagingLocked ? 'Y' : 'N'}`;

  lines.push('', portLine);
  return lines.join('\n');
}

class SpectrumTranscribeDriver implements TranscribeDriver {
  private extraFonts: readonly FontSource[] | undefined;

  constructor(private readonly s: Spectrum) {}

  get active(): boolean { return this.s.screenText.active; }

  activate(extraFonts?: readonly FontSource[]): void {
    this.s.screenText.activate();
    this.extraFonts = extraFonts;
  }

  deactivate(): void {
    this.s.screenText.deactivate();
    this.extraFonts = undefined;
  }

  run(): { text: string; html: string; grid: OcrGridName } {
    const s = this.s;
    const result = s.ocrScreenStyled(this.extraFonts as FontSource[] | undefined, 'auto');
    // Blank matched character cells in the framebuffer and re-upload, so the
    // crisp overlay glyphs replace the bitmap underneath.
    if (result.mask.length > 0) {
      s.ula.blankCells(
        s.memory.screenBank, result.mask, 0x4000,
        result.cellWidth, result.cellHeight, result.cols, result.rows,
      );
      if (s.display) s.display.updateTexture(s.ula.pixels);
    }
    return result;
  }
}

export class SpectrumFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;
  readonly transcribe: SpectrumTranscribeDriver;

  constructor(private readonly s: Spectrum) {
    const spec = s;
    this.transcribe = new SpectrumTranscribeDriver(s);
    this.panes = {
      hasSysvars: true,
      banksHtml: () => spec.variant.hasBanking ? renderBanks(spec) : null,
      basicListing: () => parseBasicProgram(spec.memory.snapshot()),
      basicVars: () => parseBasicVariables(spec.memory.snapshot()),
      // Font-pane ROM capture: the current CHARS font, when its space glyph is
      // blank (the heuristic that filters garbage). Hash-cache stays bridge-side.
      romFontCandidate: () => {
        const snap = spec.memory.snapshot();
        let charsAddr = snap[0x5C36] | (snap[0x5C37] << 8);
        if (charsAddr === 0) charsAddr = 0x3C00;
        const fontStart = charsAddr + 256;
        if (fontStart + 768 > 65536) return null;
        for (let i = 0; i < 8; i++) if (snap[fontStart + i] !== 0) return null;
        return { fontStart, snap };
      },
    };
  }

  sample(out: FrameIndicators): void {
    const s = this.s;
    const a = s.activity;
    const v = s.variant;
    const tape = s.tape;

    out.keyboard = a.ulaReads;
    out.joystick = a.kempstonReads;
    out.mouse = a.mouseReads;
    out.tapeIn = a.earReads;
    // TAPE LED = the tape is actively rolling; ROM LD-BYTES hits alone miss
    // custom/turbo loaders (they poll the port from their own code).
    out.tapeLoad = (tape.playing && !tape.paused) || a.tapeLoads > 0 ? 1 : 0;
    out.beeper = a.beeperToggled ? 1 : 0;
    out.psg = a.ayWrites > 5 ? 1 : 0;
    out.videoFx = a.attrWrites > 768 ? 1 : 0;
    out.disk = (a.fdcAccesses > 0
      || (s.mgtPlusD.enabled && s.mgtPlusD.fdc.motorOn)
      || (s.betaDisk.enabled && s.betaDisk.fdc.motorOn)
      || (s.interface1.enabled && s.interface1.anyMotorOn)) ? 1 : 0;
    out.tapeTurbo = s.tapeTurboActive;

    out.tapeLoaded = tape.loaded;
    out.tapePlaying = tape.playing;
    out.tapePaused = tape.paused;
    out.tapeFinished = tape.finished;
    out.tapePosition = tape.position;
    out.casBlock = -1;
    const loadingNow = tape.loaded && tape.playing && !tape.paused && !tape.finished;
    out.fastRomLoading = loadingNow && s.tapeFastRom && a.tapeLoads > 0;

    out.tracingActive = s.tracing;

    // ── Drive panel slots: A/B = uPD765A, C/D = +D or Beta Disk ──
    out.driveLed[0] = out.driveLed[1] = out.driveLed[2] = out.driveLed[3] = -1;
    if (v.hasFDC) {
      const activeUnit = s.fdc.currentUnit;
      fillDriveSlot(out, 0, s.fdc, 0, activeUnit);
      fillDriveSlot(out, 1, s.fdc, 1, activeUnit);
    }
    const wd = activeWd(s);
    if (wd) {
      const wdActive = wd.currentUnit;
      fillDriveSlot(out, 2, wd, 0, wdActive);
      fillDriveSlot(out, 3, wd, 1, wdActive);
    }

    // Microdrive motors (IF1).
    if (s.interface1.enabled) {
      out.mdvCount = 8;
      let mask = 0;
      const drives = s.interface1.drives;
      for (let i = 0; i < 8; i++) if (drives[i].motorOn) mask |= 1 << i;
      out.mdvMotorMask = mask;
    } else {
      out.mdvCount = 0;
      out.mdvMotorMask = 0;
    }

    // ── Floppy drive-sound feed (the +3 uPD765A, or the +D/Beta WD) ──
    // Slot picks the per-drive sound setting: 0/1 = A/B (+3), 2/3 = C/D (WD).
    out.floppySlot = -1;
    out.floppyProfile = -1;
    if (v.hasFDC) {
      out.floppySlot = s.fdc.currentUnit === 0 ? 0 : 1;
      out.floppyMotor = s.fdc.motorOn;
      out.floppyTrack = s.fdc.currentTrack;
      // 3" CF2 vs 3.5" picked from the mounted disk's capacity; keep the
      // synth's current profile when the drive is empty (as before).
      const disk = s.fdc.getDiskImage(s.fdc.currentUnit);
      if (disk) {
        const t0 = disk.tracks[0]?.[0];
        const spt = t0 ? t0.sectors.length : 0;
        const secSize = t0?.sectors[0] ? (128 << t0.sectors[0].n) : 512;
        const capacityKB = (disk.numSides * disk.numTracks * spt * secSize) / 1024;
        out.floppyProfile = capacityKB > 500 ? 1 : 0;
      }
    } else if (wd) {
      // The +D always used 3.5" drives; the Beta shares the same sound model.
      out.floppySlot = wd.currentUnit === 0 ? 2 : 3;
      out.floppyMotor = wd.motorOn;
      out.floppyTrack = wd.currentTrack;
      out.floppyProfile = 1;
    }
  }

  frameTick(out: FrameIndicators): void {
    const s = this.s;

    if (s.variant.hasFDC) {
      s.fdc.tickFrame();
      // Surface unimplemented SCAN commands (see upd765a.cmdUnsupportedScan).
      if (s.fdc.unsupportedScan >= 0) {
        out.scanUnsupported = s.fdc.unsupportedScan;
        s.fdc.unsupportedScan = -1;
      }
      // A completed FORMAT re-detects disk metadata via the bridge.
      if (s.fdc.formattedUnit >= 0) {
        out.formattedSlot = s.fdc.formattedUnit;
        s.fdc.formattedUnit = -1;
      }
    }
    const wd = activeWd(s);
    if (wd) {
      wd.tickFrame();
      if (wd.formattedUnit >= 0) {
        out.formattedSlot = 2 + wd.formattedUnit;
        wd.formattedUnit = -1;
      }
    }

    // Auto-rewind: tape just ran out → rewind to start in play+paused state,
    // ready for the next EAR read to unpause.
    if (s.tapeAutoRewind && s.tape.loaded && !s.tape.playing && s.tape.finished) {
      s.tape.position = 0;
      s.tape.paused = true;
      s.tape.startPlayback();
    }
  }

  diskImageForSlot(slot: number): DskImage | null {
    const s = this.s;
    if (slot <= 1) return s.variant.hasFDC ? s.fdc.getDiskImage(slot) : null;
    const wd = activeWd(s);
    return wd ? wd.getDiskImage(slot - 2) : null;
  }
}
