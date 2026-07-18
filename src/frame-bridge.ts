/**
 * Per-frame bridge: the GENERIC consumer of each machine's FrameProbe.
 *
 * The machine-specific per-frame bodies that used to live here (one per
 * machine, reaching into activity counters, FDC motors, tape decks and screen
 * OCR) moved into each machine's `services.probe` (Phase 5 of
 * docs/re-architecture.md). This file now:
 *   - calls `probe.sample()` into ONE preallocated FrameIndicators struct,
 *   - owns presentation policy: the 500ms LED latch, string formatting,
 *     signal diffing, pane-open gating and the turbo UI throttle,
 *   - keeps the machine-agnostic helpers (clock-speed readout, breakpoint
 *     pause, disassembly refresh, font preview).
 *
 * `probe.sample()` is a pure, allocation-free read; device bookkeeping that
 * must run once per UI frame (FDC frame ticks, format/SCAN event latches,
 * tape auto-rewind) happens in `probe.frameTick()`, called at the throttled
 * signal-batch cadence — the same cadence the old per-machine bodies ran at.
 */

import { batch } from 'solid-js';
import type { FontSource } from '@/ocr/spectrum.ts';
import { isCollapsed } from '@/ui/panes.ts';
import * as settings from '@/store/settings.ts';
import { refreshDiskMetadata } from '@/media/floppy/dsk.ts';
import {
  machine, floppySound,
  emulationPaused, tracing,
  setRegsRev, setSysvarRev, setBasicHtml, setBasicVarsHtml,
  setBanksHtml, setDriveAStatus, setDriveBStatus, setShowTrapLog, setDisasmText,
  setCurrentDiskInfo, setCurrentDiskInfoB,
  setDriveCStatus, setDriveDStatus, setCurrentDiskInfoC, setCurrentDiskInfoD,
  setClockSpeedText,
  setTapePosition, setCasPosition, tapePaused, setTapePaused, tapePlaying, setTapePlaying, transcribeMode, setTranscribeText, setTranscribeHtml, setTranscribeGrid,
  setLedKbd, setLedKemp, setLedEar, setLedLoad, setLedText,
  setLedBeep, setLedAy, setLedDsk, setLedRainbow, setLedMouse, setLedTapeTurbo,
  setStatus, setEmulationPaused, setTracing,
  getPendingRunTo, clearPendingRunTo,
} from '@/emulator.ts';

import { createFrameIndicators, type FrameProbe } from '@/machines/machine.ts';
import { hex16 } from '@/utils/hex.ts';
import { microdriveMotors, setMicrodriveMotors } from '@/state/microdrive-state.ts';
import type { DriveStatus, DriveLed } from '@/state/disk-state.ts';

// The ONE shared indicators struct — machines overwrite it in place (§6).
const ind = createFrameIndicators();

// Tracks the fast-load message last shown so we announce only on a transition
// (and re-announce for a fresh load), not every frame.
let lastLoadAnnounce = '';

// Machine trace-engine state as of the previous sample (auto-stop edge detect).
let prevTracingActive = false;

// ── Drive panel signals ─────────────────────────────────────────────────
//
// The probe reports drive telemetry as numbers; the bridge formats the
// DriveStatus objects and only touches a signal when its slot actually
// changed (Solid would dedupe equal primitives, but these are objects).

const DRIVE_LEDS: DriveLed[] = ['off', 'motor', 'read', 'write'];
const driveSetters = [setDriveAStatus, setDriveBStatus, setDriveCStatus, setDriveDStatus] as const;
const diskInfoSetters = [setCurrentDiskInfo, setCurrentDiskInfoB, setCurrentDiskInfoC, setCurrentDiskInfoD] as const;
// Previous per-slot values; led -2 = never published, forces the first write.
const prevDrive = [0, 1, 2, 3].map(() => ({ led: -2, track: -1, sector: -2, dirty: -1 }));

function applyDriveSignals(): void {
  for (let slot = 0; slot < 4; slot++) {
    const led = ind.driveLed[slot];
    if (led < 0) continue;                    // slot absent on this machine
    const p = prevDrive[slot];
    const track = ind.driveTrack[slot], sector = ind.driveSector[slot], dirty = ind.driveDirty[slot];
    if (p.led === led && p.track === track && p.sector === sector && p.dirty === dirty) continue;
    p.led = led; p.track = track; p.sector = sector; p.dirty = dirty;
    const status: DriveStatus = {
      led: DRIVE_LEDS[led],
      track: track.toString().padStart(2, '0'),
      sector: sector < 0 ? '--' : sector.toString().padStart(2, '0'),
      dirty: dirty !== 0,
    };
    driveSetters[slot](status);
  }
}

/** Clear the drive-status diff cache (machine reset / model switch). */
function resetDriveCache(): void {
  for (const p of prevDrive) { p.led = -2; p.track = -1; p.sector = -2; p.dirty = -1; }
}

// ── Debug panel updates ─────────────────────────────────────────────────

/** Refresh the disassembly around PC for the active machine (the CPU-family
 *  debug provider owns the formatting). */
function updateDisasm(): void {
  setDisasmText(machine!.services.debug.disasmPaneHtml(24));
}

export function updateRegsOnce(): void {
  if (!machine) return;
  const probe = machine.services?.probe;
  batch(() => {
    setRegsRev(v => v + 1);
    updateDisasm();
    // Machine-provided debug panes (sysvars, BASIC, memory layout).
    const panes = probe?.panes;
    if (panes) {
      if (panes.hasSysvars) setSysvarRev(v => v + 1);
      if (panes.basicHtml) setBasicHtml(panes.basicHtml());
      if (panes.basicVarsHtml) setBasicVarsHtml(panes.basicVarsHtml());
      if (panes.banksHtml) {
        const banks = panes.banksHtml();
        if (banks !== null) setBanksHtml(banks);
      }
    }
    // Device bookkeeping + drive telemetry (paused/stepping refresh).
    if (probe) {
      ind.formattedSlot = -1;
      ind.scanUnsupported = -1;
      probe.frameTick?.(ind);
      probe.sample(ind);
      applyDriveSignals();
      handleDriveEvents(probe);
    }
  });
}

/** Post-format metadata refresh + unsupported-SCAN surfacing (one-shot events
 *  consumed by frameTick into the indicators). */
function handleDriveEvents(probe: FrameProbe): void {
  if (ind.driveLed[0] >= 0) setShowTrapLog(false);
  if (ind.scanUnsupported >= 0) {
    setStatus(`Unsupported 765A FDC SCAN command (0x${ind.scanUnsupported.toString(16).toUpperCase().padStart(2, '0')}) — rejected`);
  }
  if (ind.formattedSlot >= 0 && probe.diskImageForSlot) {
    const image = probe.diskImageForSlot(ind.formattedSlot);
    if (image) {
      refreshDiskMetadata(image);
      // Spread to new reference so Solid.js reactive graph sees the change
      diskInfoSetters[ind.formattedSlot]({ ...image });
    }
  }
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
  resetDriveCache();
  lastLoadAnnounce = '';
  prevTracingActive = false;
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

// Sustained tape-turbo engine state as of the last probe sample (feeds the
// clock label; sourced from FrameIndicators.tapeTurbo, not any concrete machine).
let lastTapeTurbo = false;

/** Sample emulated T-states against wall-clock to derive a realtime multiplier.
 *  Called once per rAF; only commits a new figure every ~350 ms so the reading
 *  is responsive but stable. Skips windows spanning a reset, snapshot load or
 *  pause (negative or implausibly long deltas) rather than printing garbage. */
function sampleSpeed(now: number): void {
  if (!machine) return;
  const t = machine.services.debug.tStates;
  if (_spdSampleWall === 0) { _spdSampleWall = now; _spdSampleT = t; return; }
  const dWall = now - _spdSampleWall;
  if (dWall < 350) return;                    // ~3 Hz update cadence
  const dT = t - _spdSampleT;
  _spdSampleWall = now;
  _spdSampleT = t;
  // Reset/snapshot/wrap → dT<=0; pause/tab-hidden → dWall huge. Drop the figure.
  if (dT <= 0 || dWall > 2000) { _spdMultiplier = 0; return; }
  const clock = machine.cpuClockHz || 3_500_000;
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
  if (machine.turbo || lastTapeTurbo) {
    return _spdMultiplier > 0 ? formatMultiplier(_spdMultiplier) : 'Turbo';
  }
  return (Math.trunc(machine.cpuClockHz / 10_000) / 100).toFixed(2);
}

export function resetSpeedTracking(): void {
  // Drop any in-flight speed sample so a reset/model-switch doesn't measure
  // across the discontinuity (stale baseline → garbage multiplier).
  _spdSampleWall = 0;
  _spdMultiplier = 0;
  // Prime the sustained tape-turbo state so the label is right immediately
  // (matches the old direct tapeTurboActive read).
  const probe = machine?.services?.probe;
  if (probe) {
    probe.sample(ind);
    lastTapeTurbo = ind.tapeTurbo;
  } else {
    lastTapeTurbo = false;
  }
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
    // ROM-font capture is a machine-provided hook (Spectrum CHARS heuristic);
    // machines without one have no capturable font.
    const candidate = machine?.services?.probe?.panes?.romFontCandidate?.();
    if (!candidate) return null;
    const { fontStart, snap } = candidate;

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

/** Decode the user font store into FontSource entries for the OCR engine
 *  (built once, at transcribe activation). */
function buildExtraFonts(): FontSource[] {
  return loadFontStore().map(e => {
    const binary = atob(e.data);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    return { label: e.label, data };
  });
}

// ── onFrame callback ────────────────────────────────────────────────────

/** Pause on a breakpoint / run-to hit (any machine, every rAF). */
function checkBreakpoint(): void {
  const m = machine!;
  if (m.breakpointHit < 0) return;
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

/** Feed the floppy drive-sound synth from the latest sample (every rAF, like
 *  the old direct FDC reads — spin-downs stay live under turbo). */
function feedFloppySound(): void {
  if (!floppySound) return;
  const slot = ind.floppySlot;
  const soundOn =
    slot === 0 ? settings.diskSoundA()
    : slot === 1 ? settings.diskSoundB()
    : slot === 2 ? settings.diskSoundC()
    : slot === 3 ? settings.diskSoundD()
    : false;
  if (soundOn) {
    // Attach to the machine's audio context if not already attached.
    const ctx = machine!.audioContext;
    if (!floppySound['ctx'] && ctx) floppySound.attach(ctx);
    if (ind.floppyProfile === 1) floppySound.driveType = '3.5inch';
    else if (ind.floppyProfile === 0) floppySound.driveType = '3inch';
    // Update motor state (this generates the sounds)
    floppySound.update(ind.floppyMotor, ind.floppyTrack);
  } else {
    // Stop any running motor sound when disabled
    floppySound.reset();
  }
}

export function onFrame(): void {
  if (!machine) return;
  // Clock-speed readout applies to every machine.
  updateClockSpeed();
  // Breakpoint / run-to check runs every rAF, even under turbo.
  checkBreakpoint();

  const probe = machine.services?.probe;
  if (!probe) {
    // No probe (bare test stub): keep the debugger pane alive and stop there.
    if (!isCollapsed('disasm-panel')) {
      setRegsRev(v => v + 1);
      if (emulationPaused()) updateDisasm();
    }
    return;
  }

  // Pure read of this frame's indicator state (allocation-free, every rAF).
  probe.sample(ind);
  lastTapeTurbo = ind.tapeTurbo;

  // Sync tracing signal if the machine's trace engine auto-stopped (buffer
  // full). Edge-triggered so machines whose startTrace is a no-op (their
  // engine never turns on) don't immediately cancel a UI trace request.
  if (tracing() && prevTracingActive && !ind.tracingActive) {
    const text = machine.services.debug.stopTrace();
    setTracing(false);
    navigator.clipboard.writeText(text);
    setStatus(`Trace auto-stopped and copied (${text.split('\n').length.toLocaleString()} lines)`);
  }
  prevTracingActive = ind.tracingActive;

  // In turbo, throttle the reactive UI batch to ~10Hz — Solid.js signal
  // updates here drive LED/register/sysvar panes, which the user can't
  // perceive at hundreds of MHz of emulated speed. Speed readout and
  // breakpoint check (above) still run every rAF; the floppy sound feed
  // (below) does too.
  const turboActive = machine.turbo || ind.tapeTurbo;
  let skipUiBatch = false;
  if (turboActive) {
    const nowMs = performance.now();
    if (nowMs - _lastTurboUiUpdate < 100) skipUiBatch = true;
    else _lastTurboUiUpdate = nowMs;
  }

  if (!skipUiBatch) {
    // Once-per-UI-frame device bookkeeping (FDC frame ticks, one-shot event
    // latches, tape auto-rewind), then re-sample so the signals below see the
    // post-tick state.
    ind.formattedSlot = -1;
    ind.scanUnsupported = -1;
    probe.frameTick?.(ind);
    probe.sample(ind);

    batch(() => {
      // Activity LEDs are latched on for 500ms past their last activity (see
      // ledLatched) so bursty per-frame counters don't strobe the indicators.
      const ledNow = performance.now();
      setLedKbd(ledLatched('kbd', ind.keyboard > 0, ledNow));
      setLedKemp(ledLatched('kemp', ind.joystick > 0, ledNow));
      const earOn = ledLatched('ear', ind.tapeIn > 0, ledNow);
      setLedEar(earOn);
      setLedLoad(ledLatched('load', ind.tapeLoad > 0, ledNow));
      setLedBeep(ledLatched('beep', ind.beeper > 0, ledNow));
      setLedAy(ledLatched('ay', ind.psg > 0, ledNow));
      setLedDsk(ledLatched('dsk', ind.disk > 0, ledNow));
      setLedRainbow(ledLatched('rainbow', ind.videoFx > 0, ledNow));
      setLedMouse(ledLatched('mouse', ind.mouse > 0, ledNow));
      // tapeTurbo is sustained engine state, not a burst — reflect immediately.
      setLedTapeTurbo(ind.tapeTurbo);
      // The transcribe-mode half is sustained user state (immediate); the EAR
      // half shares the latched 500ms hold used by the EAR LED.
      setLedText(transcribeMode() === 'text' || earOn);

      // Announce the active fast-load mechanism once per load (on transition,
      // not every frame). Custom loaders are accelerated by turbo, whose speed
      // shows in the CPU readout.
      const loadingNow = ind.tapeLoaded && ind.tapePlaying && !ind.tapePaused && !ind.tapeFinished;
      if (!loadingNow) {
        lastLoadAnnounce = '';
      } else if (ind.fastRomLoading && lastLoadAnnounce !== 'Fast ROM loading') {
        setStatus('Fast ROM loading');
        lastLoadAnnounce = 'Fast ROM loading';
      }

      // Cassette transport: keep the tape pane's position/play state in sync
      // (may change via ROM trap, loader detector, or auto-rewind).
      if (ind.tapeLoaded) {
        setTapePosition(ind.tapePosition);
        if (tapePlaying() !== ind.tapePlaying) setTapePlaying(ind.tapePlaying);
        if (tapePaused() !== ind.tapePaused) setTapePaused(ind.tapePaused);
      }
      // Instant-load cassette block highlight (MSX CLOAD/BLOAD sweep).
      if (ind.casBlock >= 0) setCasPosition(ind.casBlock);

      // Per-drive microdrive motor LEDs (latched so brief spins stay visible).
      if (ind.mdvCount > 0) {
        const motors: boolean[] = [];
        for (let i = 0; i < ind.mdvCount; i++) {
          motors.push(ledLatched('mdrmotor' + i, (ind.mdvMotorMask >> i & 1) !== 0, ledNow));
        }
        const cur = microdriveMotors();
        if (motors.some((m, i) => m !== cur[i])) setMicrodriveMotors(motors);
      }

      // Drive panel telemetry + one-shot drive events.
      applyDriveSignals();
      handleDriveEvents(probe);

      // Registers — only if debugger pane is open.
      if (!isCollapsed('disasm-panel')) {
        setRegsRev(v => v + 1);
        // Disassembly only when paused (breakpoint hit etc.)
        if (emulationPaused()) updateDisasm();
      }

      // Sysvars + BASIC — throttled to ~1Hz, only if the pane is open.
      const panes = probe.panes;
      const now = performance.now();
      if (now - _lastSlowUpdate > 1000) {
        _lastSlowUpdate = now;
        if (panes?.hasSysvars && !isCollapsed('sysvar-panel')) setSysvarRev(v => v + 1);
        if (panes?.basicHtml && !isCollapsed('basic-panel')) setBasicHtml(panes.basicHtml());
        if (panes?.basicVarsHtml && !isCollapsed('basic-vars-panel')) setBasicVarsHtml(panes.basicVarsHtml());
      }
      // Memory layout — cheap; refresh live so paging shows as games bank-switch.
      if (panes?.banksHtml && !isCollapsed('banks-panel')) {
        const banks = panes.banksHtml();
        if (banks !== null) setBanksHtml(banks);
      }

      // TEXT overlay: OCR the screen, push text/HTML to the overlay; the driver
      // blanks the matched cells and re-uploads the display itself.
      const transcribe = probe.transcribe;
      if (transcribeMode() !== 'off' && transcribe) {
        if (!transcribe.active) transcribe.activate(buildExtraFonts());
        const result = transcribe.run();
        setTranscribeText(result.text);
        setTranscribeHtml(result.html);
        setTranscribeGrid(result.grid);
      } else if (transcribe?.active) {
        transcribe.deactivate();
      }
    });
  }

  // Floppy sound (non-signal side effect) — every rAF, from the latest sample.
  feedFloppySound();
}
