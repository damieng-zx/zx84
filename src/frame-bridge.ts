/**
 * Per-frame bridge: reads machine state, updates UI signals.
 *
 * Extracted from emulator.ts — contains all render helpers,
 * LED/clock/font updates, and the onFrame callback.
 */

import { batch } from 'solid-js';
import { isPlus2AClass } from '@/models.ts';
import { disassembleAroundPC, formatDisasmHtml } from '@/debug/z80-disasm.ts';
import type { FontSource } from '@/debug/screen-text.ts';
import { parseBasicProgram, parseBasicVariables } from '@/debug/basic-parser.ts';
import { parseLocomotiveBasic } from '@/debug/cpc-basic-parser.ts';
import { isCollapsed } from '@/ui/panes.ts';
import * as settings from '@/store/settings.ts';
import { refreshDiskMetadata } from '@/floppy/dsk.ts';
import {
  machine, spectrum, floppySound,
  currentModel, emulationPaused, tracing,
  setRegsRev, setSysvarRev, setBasicHtml, setBasicVarsHtml,
  setBanksHtml, setDriveAStatus, setDriveBStatus, setShowTrapLog, setDisasmText,
  setCurrentDiskInfo, setCurrentDiskInfoB,
  setDriveCStatus, setDriveDStatus, setCurrentDiskInfoC, setCurrentDiskInfoD,
  setClockSpeedText,
  setTapePosition, tapePaused, setTapePaused, tapePlaying, setTapePlaying, transcribeMode, setTranscribeText, setTranscribeHtml, setTranscribeGrid,
  setLedKbd, setLedKemp, setLedEar, setLedLoad, setLedText,
  setLedBeep, setLedAy, setLedDsk, setLedRainbow, setLedMouse, setLedTapeTurbo,
  setStatus, setEmulationPaused, setTracing,
  getPendingRunTo, clearPendingRunTo,
} from '@/emulator.ts';

import { asCpc, asEinstein } from '@/machine.ts';
import { hex8, hex16 } from '@/utils/hex.ts';
import { microdriveMotors, setMicrodriveMotors } from '@/state/microdrive-state.ts';

// Tracks the fast-load message last shown so we announce only on a transition
// (and re-announce for a fresh load), not every frame.
let lastLoadAnnounce = '';

// ── Hardware panel rendering ────────────────────────────────────────────

function renderBanks(): string {
  const mem = spectrum!.memory;
  const model = currentModel();
  const n = '<span class="reg-name">';
  const e = '</span>';
  const plus2a = isPlus2AClass(model);

  // Helper to format a memory region
  const region = (addr: string, label: string) => `${n}${addr}${e} ${label}`;

  const lines: string[] = [];

  // Determine memory layout
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
    // Normal paging
    const romNum = mem.currentROM;
    let romLabel = '';
    if (plus2a) {
      romLabel = `ROM Page ${romNum}`;
    } else {
      romLabel = romNum === 0 ? '128K Editor ROM' : '48K BASIC ROM';
    }

    const screenBank = (mem.port7FFD & 0x08) ? 7 : 5;
    const isScreenPage = (bank: number) => bank === screenBank;

    lines.push(
      region('C000-FFFF', `RAM Bank ${mem.currentBank}${isScreenPage(mem.currentBank) ? ' (Screen)' : ''}`),
      region('8000-BFFF', `RAM Bank 2`),
      region('4000-7FFF', `RAM Bank 5${isScreenPage(5) ? ' (Screen)' : ''}`),
      region('0000-3FFF', romLabel),
    );
  }

  // Port values and status
  let portLine = `${n}7FFD${e} ${hex8(mem.port7FFD)}`;
  if (plus2a) portLine += `  ${n}1FFD${e} ${hex8(mem.port1FFD)}`;
  portLine += `  ${n}Lock${e} ${mem.pagingLocked ? 'Y' : 'N'}`;

  lines.push('', portLine);

  return lines.join('\n');
}

/**
 * Render the CPC memory-layout pane. Unlike the Spectrum (a flat 64KB view), the
 * CPC overlays ROM on RAM with write fall-through, so each Z80 slot is shown as a
 * CPU-*read* source (ROM or RAM) and the RAM bank the CPU *writes* beneath it.
 * The footer decodes the RAM configuration, the selected/enabled ROMs, the video
 * DMA the CRTC sees, and the Gate-Array screen mode.
 */
function renderCpcBanks(cpc: import('@/cpc/cpc-machine.ts').CpcMachine): string {
  const mem = cpc.memory;
  const p = mem.pagingState();
  const n = '<span class="reg-name">';
  const e = '</span>';

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
  const lines: string[] = [`${n}           CPU read  CPU write${e}`];

  for (let row = 0; row < 4; row++) {
    const slot = 3 - row;
    let read: string;
    if (slot === 0 && p.lowerRomEnabled) {
      read = 'OS ROM';
    } else if (slot === 3 && p.upperRomEnabled) {
      const absent = mem.getUpperRom(p.selectedUpperRom) === undefined;
      read = absent ? `${upperName(p.selectedUpperRom)}!` : upperName(p.selectedUpperRom);
    } else {
      read = `RAM ${p.slotBanks[slot]}`;
    }
    const mark = slot === screenSlot ? '  ◀screen' : '';
    lines.push(`${n}${ranges[row]}${e}  ${read.padEnd(9)}→ RAM ${p.slotBanks[slot]}${mark}`);
  }

  lines.push('');
  lines.push(`${n}RAM config${e} ${p.ramConfig} → [${p.slotBanks.join(' ')}]  ${n}64K blk${e} ${p.ram64kBlock}`);
  lines.push(
    `${n}Upper ROM${e}  ${p.selectedUpperRom} ${upperName(p.selectedUpperRom)}` +
    `  ${n}Low${e} ${p.lowerRomEnabled ? 'on' : 'off'}  ${n}High${e} ${p.upperRomEnabled ? 'on' : 'off'}`,
  );
  lines.push(`${n}Video DMA${e}  bank ${screenBank}  ${n}base${e} &${hex16(screenBase)}`);
  lines.push(`${n}Gate Array${e} mode ${cpc.gateArray.mode}`);

  return lines.join('\n');
}

// Disk info now rendered directly in DrivePane component

/** Minimal FDC surface the drive readout needs — satisfied by both the
 *  uPD765A (+3) and the WD1772 (+D). */
interface DriveStatusSource {
  motorOn: boolean;
  isExecuting: boolean;
  isWriting: boolean;
  currentSector: number;
  getUnitTrack(unit: number): number;
  isDirty(unit: number): boolean;
}

function renderDriveStatus(unit: number, activeUnit: number, fdc: DriveStatusSource): import('@/state/disk-state.ts').DriveStatus {
  const isActive = unit === activeUnit;
  const track = fdc.getUnitTrack(unit).toString().padStart(2, '0');
  const sector = fdc.isExecuting && isActive ? fdc.currentSector.toString().padStart(2, '0') : '--';

  let led: import('@/state/disk-state.ts').DriveLed;
  if (!fdc.motorOn || !isActive) {
    led = 'off';
  } else if (!fdc.isExecuting) {
    led = 'motor';
  } else if (fdc.isWriting) {
    led = 'write';
  } else {
    led = 'read';
  }

  return { led, track, sector, dirty: fdc.isDirty(unit) };
}

/** Update banks, disk info, drive status, and trap log signals. */
function updateHardwareSignals(activeUnit: number): void {
  const v = spectrum!.variant;
  if (v.hasBanking) {
    setBanksHtml(renderBanks());
  }
  if (v.hasFDC) {
    spectrum!.fdc.tickFrame();
    setDriveAStatus(renderDriveStatus(0, activeUnit, spectrum!.fdc));
    setDriveBStatus(renderDriveStatus(1, activeUnit, spectrum!.fdc));
    setShowTrapLog(false);

    // Surface unimplemented SCAN commands (see upd765a.cmdUnsupportedScan)
    const scan = spectrum!.fdc.unsupportedScan;
    if (scan >= 0) {
      spectrum!.fdc.unsupportedScan = -1;
      setStatus(`Unsupported 765A FDC SCAN command (0x${scan.toString(16).toUpperCase().padStart(2, '0')}) — rejected`);
    }

    // If a format just completed, re-detect disk metadata and refresh the signal
    const fu = spectrum!.fdc.formattedUnit;
    if (fu >= 0) {
      spectrum!.fdc.formattedUnit = -1;
      const image = spectrum!.fdc.getDiskImage(fu);
      if (image) {
        refreshDiskMetadata(image);
        // Spread to new reference so Solid.js reactive graph sees the change
        if (fu === 0) setCurrentDiskInfo({ ...image });
        else          setCurrentDiskInfoB({ ...image });
      }
    }
  }

  // MGT +D (WD1772) or Beta Disk (WD1793) — both drive the shared C/D signals
  // and are mutually exclusive. Independent of the +3 FDC above.
  const wd = spectrum!.mgtPlusD.enabled ? spectrum!.mgtPlusD.fdc
    : spectrum!.betaDisk.enabled ? spectrum!.betaDisk.fdc : null;
  if (wd) {
    wd.tickFrame();
    const wdActive = wd.currentUnit;
    setDriveCStatus(renderDriveStatus(0, wdActive, wd));
    setDriveDStatus(renderDriveStatus(1, wdActive, wd));

    const fu = wd.formattedUnit;
    if (fu >= 0) {
      wd.formattedUnit = -1;
      const image = wd.getDiskImage(fu);
      if (image) {
        refreshDiskMetadata(image);
        if (fu === 0) setCurrentDiskInfoC({ ...image });
        else          setCurrentDiskInfoD({ ...image });
      }
    }
  }
}

// ── Debug panel updates ─────────────────────────────────────────────────

/** Refresh the disassembly around PC for the active machine (machine-agnostic). */
function updateDisasm(): void {
  const snap = machine!.memory.snapshot();
  const cpu = machine!.cpu;
  const dLines = disassembleAroundPC(snap, cpu.pc, 24);
  setDisasmText(formatDisasmHtml(dLines, snap, cpu.pc, machine!.breakpoints));
}

/** Spectrum-only panes: system variables + BASIC listing/variables. */
function updateSpectrumDebugSignals(): void {
  setSysvarRev(v => v + 1);
  const snap = spectrum!.memory.snapshot();
  setBasicHtml(parseBasicProgram(snap));
  setBasicVarsHtml(parseBasicVariables(snap));
}

/** Render the CPC's Locomotive BASIC program into the BASIC pane. Reads the
 *  underlying RAM (the program lives at &0170 under the OS ROM overlay). */
function updateCpcBasic(cpc: import('@/cpc/cpc-machine.ts').CpcMachine): void {
  setBasicHtml(parseLocomotiveBasic(cpc.memory.ramSnapshot()));
}

export function updateRegsOnce(): void {
  if (!machine) return;
  batch(() => {
    setRegsRev(v => v + 1);
    updateDisasm();
    // The remaining debug panes are Spectrum-specific (sysvars, banks); BASIC is
    // shown for both, with a machine-specific detokenizer.
    if (spectrum) {
      updateSpectrumDebugSignals();
      const activeUnit = spectrum.variant.hasFDC ? spectrum.fdc.currentUnit : 0;
      updateHardwareSignals(activeUnit);
    } else {
      const cpc = asCpc(machine);
      if (cpc) {
        updateCpcBasic(cpc);
        setBanksHtml(renderCpcBanks(cpc));
      }
    }
  });
}

// ── Throttle for expensive per-frame work ───────────────────────────────

let _lastSlowUpdate = 0;
let _lastTurboUiUpdate = 0;

// ── Status-LED activity hold ─────────────────────────────────────────────
//
// The activity LEDs are fed by bursty per-frame counters (AY register writes,
// attribute rewrites, EAR samples, port reads …), so painting them straight
// from a single frame's tally makes the indicators strobe on and off. Instead
// latch each LED on for LED_HOLD_MS after its most recent activity: "anything
// touched it in the last 500ms → lit". The signal setters are still called
// every frame, but Solid dedupes equal values, so an LED only actually
// transitions on an activity edge or 500ms after activity ceases — no flicker.
const LED_HOLD_MS = 500;
const _ledLastActive: Record<string, number> = Object.create(null);

/** Stamp `key` active when `active` is true, and report whether it is still
 *  within the 500ms hold window. `now` is a single performance.now() per frame
 *  so every LED in the same batch shares one clock reading. */
function ledLatched(key: string, active: boolean, now: number): boolean {
  if (active) _ledLastActive[key] = now;
  const last = _ledLastActive[key];
  return last !== undefined && now - last < LED_HOLD_MS;
}

/** Clear all LED hold state (machine reset / model switch / tests). */
export function resetLedActivity(): void {
  for (const k in _ledLastActive) delete _ledLastActive[k];
}

// ── Clock-speed readout ─────────────────────────────────────────────────
//
// At nominal speed we show the machine's fixed CPU clock — 3.54 MHz (128K
// family), 3.50 MHz (48K), 4.00 MHz (CPC). In turbo we show a *measured*
// realtime multiplier (e.g. "23×"): emulated T-states advanced per wall-clock
// second, divided by the nominal clock. (The old always-on measured-MHz EMA was
// removed for drifting/reading negative across reset/wrap boundaries; this
// sampler is guarded against those and only drives the turbo readout.)

let shownClockLabel = '';

// Measured-speed sampler: emulated tStates vs wall-clock, refreshed ~3×/sec.
let _spdSampleT = 0;        // machine.cpu.tStates at the last accepted sample
let _spdSampleWall = 0;     // performance.now() at the last accepted sample
let _spdMultiplier = 0;     // last measured ×realtime (0 = no valid sample yet)

/** Sample emulated T-states against wall-clock to derive a realtime multiplier.
 *  Called once per rAF; only commits a new figure every ~350 ms so the reading
 *  is responsive but stable. Skips windows spanning a reset, snapshot load or
 *  pause (negative or implausibly long deltas) rather than printing garbage. */
function sampleSpeed(now: number): void {
  if (!machine) return;
  const t = machine.cpu.tStates;
  if (_spdSampleWall === 0) { _spdSampleWall = now; _spdSampleT = t; return; }
  const dWall = now - _spdSampleWall;
  if (dWall < 350) return;                    // ~3 Hz update cadence
  const dT = t - _spdSampleT;
  _spdSampleWall = now;
  _spdSampleT = t;
  // Reset/snapshot/wrap → dT<=0; pause/tab-hidden → dWall huge. Drop the figure.
  if (dT <= 0 || dWall > 2000) { _spdMultiplier = 0; return; }
  const clock = machine.tape.cpuClock || 3_500_000;
  _spdMultiplier = (dT / (dWall / 1000)) / clock;
}

/** Format a realtime multiplier compactly: one decimal below 10× ("8.4×"),
 *  whole numbers at/above ("23×", "140×"). */
function formatMultiplier(m: number): string {
  return m >= 10 ? `${Math.round(m)}×` : `${m.toFixed(1)}×`;
}

/** The label the CPU-speed button should show: a measured "N×" while the
 *  machine runs flat-out (manual turbo or auto tape-turbo) — "Turbo" until the
 *  first sample lands — otherwise the nominal clock as "N.NN" (truncated, so the
 *  128K's 3.5469 MHz reads as the conventional 3.54; 48K → 3.50, CPC → 4.00). */
function clockLabel(): string {
  if (!machine) return '';
  if (machine.turbo || (spectrum?.tapeTurboActive ?? false)) {
    return _spdMultiplier > 0 ? formatMultiplier(_spdMultiplier) : 'Turbo';
  }
  return (Math.trunc(machine.tape.cpuClock / 10_000) / 100).toFixed(2);
}

export function resetSpeedTracking(): void {
  // Drop any in-flight speed sample so a reset/model-switch doesn't measure
  // across the discontinuity (stale baseline → garbage multiplier).
  _spdSampleWall = 0;
  _spdMultiplier = 0;
  shownClockLabel = clockLabel();
  setClockSpeedText(shownClockLabel);
}

function updateClockSpeed(): void {
  sampleSpeed(performance.now());
  const label = clockLabel();
  if (label !== shownClockLabel) {
    shownClockLabel = label;
    setClockSpeedText(label);
  }
}

/** Force the readout to repaint next frame (e.g. after a turbo toggle, so the
 *  "Turbo" ⇄ "3.54" flip lands immediately rather than on the next change). */
export function forceSpeedUpdate(): void {
  shownClockLabel = '\0';   // sentinel that never equals a real label
}

// ── Font preview ────────────────────────────────────────────────────────

let cachedExtraFonts: FontSource[] | undefined;
let romFontCacheAddr = -1;
let romFontCacheHash = -1;
export let capturedFontData: Uint8Array | null = null;

export function fontDataHash(data: Uint8Array, offset: number, len: number): number {
  let h = 0;
  for (let i = 0; i < len; i++) h = (h * 31 + data[offset + i]) | 0;
  return h;
}

export interface FontEntry {
  id: string;
  label: string;
  address: number | null;
  technique: 'file' | 'chars' | 'copyr' | 'scgrab';
  data: string;            // base64
}

export function updateFontPreview(): { type: 'custom'; data: Uint8Array } | { type: 'rom'; data: Uint8Array } | null {
  const id = settings.fontName();

  if (id) {
    const entries = loadFontStore();
    const entry = entries.find(e => e.id === id);
    if (!entry) return null;
    const binary = atob(entry.data);
    const font = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) font[i] = binary.charCodeAt(i);
    romFontCacheAddr = -1;
    romFontCacheHash = -1;
    return { type: 'custom', data: font };
  } else {
    if (!spectrum) return null;
    const snap = spectrum.memory.snapshot();
    let charsAddr = snap[0x5C36] | (snap[0x5C37] << 8);
    if (charsAddr === 0) charsAddr = 0x3C00;
    const fontStart = charsAddr + 256;
    if (fontStart + 768 > 65536) return null;

    let spaceBlank = true;
    for (let i = 0; i < 8; i++) { if (snap[fontStart + i] !== 0) { spaceBlank = false; break; } }
    if (!spaceBlank) return null;

    const hash = fontDataHash(snap, fontStart, 768);
    if (fontStart === romFontCacheAddr && hash === romFontCacheHash) return null;
    romFontCacheAddr = fontStart;
    romFontCacheHash = hash;

    capturedFontData = snap.slice(fontStart, fontStart + 768);
    return { type: 'rom', data: capturedFontData };
  }
}

export function loadFontStore(): FontEntry[] {
  try {
    const raw = localStorage.getItem('zx84-fonts');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Migrate old Record<string, string> format
    if (!Array.isArray(parsed)) {
      const entries: FontEntry[] = [];
      for (const [name, b64] of Object.entries(parsed)) {
        entries.push({ id: name, label: name, address: null, technique: 'file', data: b64 as string });
      }
      saveFontStore(entries);
      return entries;
    }
    return parsed;
  } catch { return []; }
}

export function saveFontStore(store: FontEntry[]): void {
  try { localStorage.setItem('zx84-fonts', JSON.stringify(store)); } catch { /* */ }
}

// ── onFrame callback ────────────────────────────────────────────────────

/** Per-frame debugger upkeep for any machine: pause on a breakpoint hit and
 *  keep the registers/disassembly live while the Debugger pane is open. The
 *  Spectrum path below has its own equivalent inline; this serves the CPC. */
function updateDebugFrame(): void {
  const m = machine!;
  if (m.breakpointHit >= 0) {
    m.stop();
    setEmulationPaused(true);
    const addr = m.breakpointHit;
    if (getPendingRunTo() === addr) {
      m.breakpoints.delete(addr);
      clearPendingRunTo();
      setStatus(`Run-to reached ${hex16(addr)}`);
    } else {
      setStatus(`Breakpoint hit at ${hex16(addr)}`);
    }
  }
  if (!isCollapsed('disasm-panel')) {
    setRegsRev(v => v + 1);
    if (emulationPaused()) updateDisasm();
  }
  // BASIC listing — throttled to ~1Hz, only when the pane is open.
  const cpc = asCpc(m);
  if (cpc && !isCollapsed('basic-panel')) {
    const now = performance.now();
    if (now - _lastSlowUpdate > 1000) {
      _lastSlowUpdate = now;
      updateCpcBasic(cpc);
    }
  }
  // Memory layout — cheap; refresh live so paging shows as games bank-switch.
  if (cpc && !isCollapsed('banks-panel')) setBanksHtml(renderCpcBanks(cpc));
}

export function onFrame(): void {
  if (!machine) return;
  // Clock-speed readout applies to every machine (Spectrum and CPC).
  updateClockSpeed();

  // The rest of the per-frame UI (tape, transcribe, BASIC) is Spectrum-specific;
  // the CPC drives just the KEYBOARD/DISK LEDs and the debugger upkeep.
  if (!spectrum) {
    const cpc = asCpc(machine);
    if (cpc) {
      const ca = cpc.activity;
      batch(() => {
        // Activity LEDs latch on for 500ms past last activity (see ledLatched)
        // so bursty per-frame counters don't strobe the indicators.
        const ledNow = performance.now();
        setLedKbd(ledLatched('kbd', ca.kbdReads > 0, ledNow));
        setLedDsk(ledLatched('dsk', ca.fdcAccesses > 0, ledNow));
        setLedMouse(ledLatched('mouse', ca.mouseReads > 0 || (cpc.amxMouse.enabled && cpc.amxMouse.active), ledNow));
        setLedLoad(ledLatched('load', ca.tapeReads > 0, ledNow));
        setLedText(transcribeMode() === 'text');

        // Cassette: keep the tape pane's position/play state in sync. No
        // loader-detector or tape-turbo machinery here — the CPC loads via
        // pulse playback (under global turbo) and the CAS READ trap.
        if (cpc.tape.loaded) {
          setTapePosition(cpc.tape.position);
          // Auto-rewind: if the tape just ran out and auto-rewind is on, rewind.
          if (!cpc.tape.playing && cpc.tape.finished && settings.tapeAutoRewind()) {
            cpc.tape.position = 0;
            cpc.tape.paused = true;
            cpc.tape.startPlayback();
            setTapePosition(0);
          }
          if (tapePlaying() !== cpc.tape.playing) setTapePlaying(cpc.tape.playing);
          if (tapePaused() !== cpc.tape.paused) setTapePaused(cpc.tape.paused);
        }

        // TEXT overlay: OCR the screen, push text/HTML to the overlay, and
        // blank the matched cells so the crisp overlay glyphs replace the
        // bitmap underneath.
        if (transcribeMode() !== 'off') {
          if (!cpc.screenText.active) cpc.screenText.activate();
          const result = cpc.ocrScreenStyled();
          setTranscribeText(result.text);
          setTranscribeHtml(result.html);
          setTranscribeGrid(result.grid);
          if (result.mask.length > 0) {
            cpc.blankCells(result.mask, result.cols, result.rows, result.paper);
            if (cpc.display) cpc.display.updateTexture(cpc.pixels);
          }
        } else if (cpc.screenText.active) {
          cpc.screenText.deactivate();
        }
      });
    }
    const ein = asEinstein(machine);
    if (ein) {
      const ea = ein.activity;
      const activeUnit = ein.fdc.currentDrive;
      batch(() => {
        const ledNow = performance.now();
        setLedKbd(ledLatched('kbd', ea.kbdReads > 0, ledNow));
        setLedDsk(ledLatched('dsk', ea.fdcAccesses > 0, ledNow));
        setLedAy(ledLatched('ay', ea.ayWrites > 5, ledNow));
        setLedText(transcribeMode() === 'text');
        // Drive A:/B: track/sector readout + LED (WD1770 units 0/1).
        setDriveAStatus(renderDriveStatus(0, activeUnit, ein.fdc));
        setDriveBStatus(renderDriveStatus(1, activeUnit, ein.fdc));

        // TEXT overlay: OCR the screen, push text/HTML to the overlay, and blank
        // the matched cells so the crisp overlay glyphs replace the bitmap.
        if (transcribeMode() !== 'off') {
          if (!ein.screenText.active) ein.screenText.activate();
          const result = ein.ocrScreenStyled();
          setTranscribeText(result.text);
          setTranscribeHtml(result.html);
          setTranscribeGrid(result.grid);
          if (result.mask.length > 0) {
            ein.blankCells(result.mask, result.cols, result.rows, result.paper);
            if (ein.display) ein.display.updateTexture(ein.pixels);
          }
        } else if (ein.screenText.active) {
          ein.screenText.deactivate();
        }
      });
    }
    updateDebugFrame();
    return;
  }

  const a = spectrum.activity;
  const v = spectrum.variant;
  const activeUnit = v.hasFDC ? spectrum.fdc.currentUnit : 0;

  // Check if a breakpoint fired this frame
  if (spectrum.breakpointHit >= 0) {
    spectrum.stop();
    setEmulationPaused(true);
    const addr = spectrum.breakpointHit;
    if (getPendingRunTo() === addr) {
      spectrum.breakpoints.delete(addr);
      clearPendingRunTo();
      setStatus(`Run-to reached ${hex16(addr)}`);
    } else {
      setStatus(`Breakpoint hit at ${hex16(addr)}`);
    }
  }

  // Sync tracing signal if trace auto-stopped (buffer full)
  if (tracing() && !spectrum.tracing) {
    const text = spectrum.stopTrace();
    setTracing(false);
    navigator.clipboard.writeText(text);
    setStatus(`Trace auto-stopped and copied (${text.split('\n').length.toLocaleString()} lines)`);
  }

  // In turbo, throttle the reactive UI batch to ~10Hz — Solid.js signal
  // updates here drive LED/register/sysvar panes, which the user can't
  // perceive at hundreds of MHz of emulated speed. Speed readout and
  // breakpoint check (above) still run every rAF; floppy sound update
  // (below) does too.
  const turboActive = spectrum.turbo || spectrum.tapeTurboActive;
  let skipUiBatch = false;
  if (turboActive) {
    const nowMs = performance.now();
    if (nowMs - _lastTurboUiUpdate < 100) skipUiBatch = true;
    else _lastTurboUiUpdate = nowMs;
  }

  if (!skipUiBatch) batch(() => {
    // Activity LEDs are latched on for 500ms past their last activity (see
    // ledLatched) so bursty per-frame counters don't strobe the indicators.
    const ledNow = performance.now();
    setLedKbd(ledLatched('kbd', a.ulaReads > 0, ledNow));
    setLedKemp(ledLatched('kemp', a.kempstonReads > 0, ledNow));
    const earOn = ledLatched('ear', a.earReads > 0, ledNow);
    setLedEar(earOn);
    // TAPE LED = the tape is actively rolling. `tapeLoads` (ROM LD-BYTES hits)
    // alone misses custom/turbo loaders — Speedlock & co. poll IN A,(0x7FFE)
    // from their own code at 0xB000+, never touching 0x0556, so the LED stayed
    // dark for the whole turbo load. Driving it off live playback state lights
    // it for every loader; it clears when playback stops or the loader-detector
    // pauses the tape at end-of-load.
    setLedLoad(ledLatched('load', (spectrum!.tape.playing && !spectrum!.tape.paused) || a.tapeLoads > 0, ledNow));
    setLedBeep(ledLatched('beep', a.beeperToggled, ledNow));
    setLedAy(ledLatched('ay', a.ayWrites > 5, ledNow));
    setLedDsk(ledLatched('dsk', a.fdcAccesses > 0
      || (spectrum!.mgtPlusD.enabled && spectrum!.mgtPlusD.fdc.motorOn)
      || (spectrum!.betaDisk.enabled && spectrum!.betaDisk.fdc.motorOn)
      || (spectrum!.interface1.enabled && spectrum!.interface1.anyMotorOn), ledNow));

    // Per-drive microdrive motor LEDs (latched so brief spins stay visible).
    if (spectrum!.interface1.enabled) {
      const drives = spectrum!.interface1.drives;
      const motors = drives.map((d, i) => ledLatched('mdrmotor' + i, d.motorOn, ledNow));
      const cur = microdriveMotors();
      if (motors.some((m, i) => m !== cur[i])) setMicrodriveMotors(motors);
    }
    setLedRainbow(ledLatched('rainbow', a.attrWrites > 768, ledNow));
    setLedMouse(ledLatched('mouse', a.mouseReads > 0, ledNow));
    // tapeTurbo is sustained engine state, not a burst — reflect it immediately.
    setLedTapeTurbo(spectrum!.tapeTurboActive);

    // Announce the active fast-load mechanism once per load (on transition, not
    // every frame). The ROM fast-load trap is the only named one now; custom
    // loaders are accelerated by turbo, whose speed shows in the CPU readout.
    const tp = spectrum!.tape;
    const loadingNow = tp.loaded && tp.playing && !tp.paused && !tp.finished;
    const loadMsg = loadingNow && spectrum!.tapeFastRom && a.tapeLoads > 0 ? 'Fast ROM loading' : '';
    if (!loadingNow) {
      lastLoadAnnounce = '';
    } else if (loadMsg && loadMsg !== lastLoadAnnounce) {
      setStatus(loadMsg);
      lastLoadAnnounce = loadMsg;
    }

    // Transcribe mode LEDs. The transcribe-mode half is sustained user state
    // (immediate); the EAR half shares the latched 500ms hold used by the EAR LED.
    setLedText(transcribeMode() === 'text' || earOn);

    // Tape position + play/pause state (may change via ROM trap or loader detector)
    if (spectrum!.tape.loaded) {
      setTapePosition(spectrum!.tape.position);

      // Auto-rewind: if tape just finished and auto-rewind is on, rewind to
      // start in play+paused state — ready for the next EAR read to unpause.
      if (!spectrum!.tape.playing && spectrum!.tape.finished && settings.tapeAutoRewind()) {
        spectrum!.tape.position = 0;
        spectrum!.tape.paused = true;
        spectrum!.tape.startPlayback();
        setTapePosition(0);
      }

      if (tapePlaying() !== spectrum!.tape.playing) {
        setTapePlaying(spectrum!.tape.playing);
      }
      if (tapePaused() !== spectrum!.tape.paused) {
        setTapePaused(spectrum!.tape.paused);
      }
    }

    // Registers — only if debugger pane is open
    if (!isCollapsed('disasm-panel')) {
      setRegsRev(v => v + 1);

      // Disassembly only when paused (breakpoint hit etc.)
      if (emulationPaused()) {
        const cpu = spectrum!.cpu;
        const snap = spectrum!.memory.snapshot();
        const dLines = disassembleAroundPC(snap, cpu.pc, 24);
        setDisasmText(formatDisasmHtml(dLines, snap, cpu.pc, spectrum!.breakpoints));
      }
    }

    // Sysvars + BASIC — throttled to ~1Hz, only if pane is open
    const now = performance.now();
    if (now - _lastSlowUpdate > 1000) {
      _lastSlowUpdate = now;
      if (!isCollapsed('sysvar-panel')) {
        setSysvarRev(v => v + 1);
      }
      if (!isCollapsed('basic-panel') || !isCollapsed('basic-vars-panel')) {
        const snap = spectrum!.memory.snapshot();
        if (!isCollapsed('basic-panel')) setBasicHtml(parseBasicProgram(snap));
        if (!isCollapsed('basic-vars-panel')) setBasicVarsHtml(parseBasicVariables(snap));
      }
    }

    updateHardwareSignals(activeUnit);

    // Transcribe overlay
    if (transcribeMode() !== 'off') {
      if (!spectrum!.screenText.active) {
        // Just toggled on — activate and snapshot the font store
        spectrum!.screenText.activate();
        cachedExtraFonts = loadFontStore().map(e => {
          const binary = atob(e.data);
          const data = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
          return { label: e.label, data };
        });
      }
      const result = spectrum!.ocrScreenStyled(cachedExtraFonts, 'auto');
      setTranscribeText(result.text);
      setTranscribeHtml(result.html);
      setTranscribeGrid(result.grid);
      // Blank matched character cells in the framebuffer and re-upload
      if (result.mask.length > 0) {
        spectrum!.ula.blankCells(
          spectrum!.memory.screenBank, result.mask, 0x4000,
          result.cellWidth, result.cellHeight, result.cols, result.rows,
        );
        if (spectrum!.display) spectrum!.display.updateTexture(spectrum!.ula.pixels);
      }
    } else {
      if (spectrum!.screenText.active) {
        spectrum!.screenText.deactivate();
        cachedExtraFonts = undefined;
      }
    }
  });

  // Floppy sound (non-signal, side effect) — drive the +3 uPD765A or +D WD1772.
  let soundFdc: typeof spectrum.fdc | typeof spectrum.mgtPlusD.fdc | null = null;
  let driveSoundOn = false;
  let isPlusD = false;
  if (v.hasFDC) {
    soundFdc = spectrum!.fdc;
    driveSoundOn = activeUnit === 0 ? settings.diskSoundA() : settings.diskSoundB();
  } else if (spectrum!.mgtPlusD.enabled) {
    soundFdc = spectrum!.mgtPlusD.fdc;
    isPlusD = true;
    driveSoundOn = soundFdc.currentUnit === 0 ? settings.diskSoundC() : settings.diskSoundD();
  } else if (spectrum!.betaDisk.enabled) {
    soundFdc = spectrum!.betaDisk.fdc;
    isPlusD = true; // same WD-family drive-sound model as the +D
    driveSoundOn = soundFdc.currentUnit === 0 ? settings.diskSoundC() : settings.diskSoundD();
  }
  if (floppySound && soundFdc && driveSoundOn) {
    // Attach to audio context if not already attached
    if (!floppySound['ctx'] && spectrum!['audio'].ctx) {
      floppySound.attach(spectrum!['audio'].ctx);
    }
    // The +D always used 3.5" drives. For the +3 path, pick the profile from the
    // disk capacity (3" CF2 vs 3.5").
    if (isPlusD) {
      floppySound.driveType = '3.5inch';
    } else {
      const disk = soundFdc.getDiskImage(soundFdc.currentUnit);
      if (disk) {
        const t0 = disk.tracks[0]?.[0];
        const spt = t0 ? t0.sectors.length : 0;
        const secSize = t0?.sectors[0] ? (128 << t0.sectors[0].n) : 512;
        const capacityKB = (disk.numSides * disk.numTracks * spt * secSize) / 1024;
        floppySound.driveType = capacityKB > 500 ? '3.5inch' : '3inch';
      }
    }
    // Update motor state (this generates the sounds)
    floppySound.update(soundFdc.motorOn, soundFdc.currentTrack);
  } else if (floppySound) {
    // Stop any running motor sound when disabled
    floppySound.reset();
  }
}
