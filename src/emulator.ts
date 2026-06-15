/**
 * Machine lifecycle: spectrum instance, ROM management, model switching.
 */

import { batch } from 'solid-js';
import { Spectrum } from '@/spectrum.ts';
import { CpcMachine } from '@/cpc/cpc-machine.ts';
import { type Machine, asSpectrum, asCpc } from '@/machine.ts';
import {
  type SpectrumModel, type MachineModel, type CpcModel,
  is128kClass, isPlus2AClass, isCpcModel, isPlusDCapable, isInterface1Capable,
} from '@/models.ts';
import { CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT, CPC_PALETTES } from '@/cpc/constants.ts';
import { WebGLRenderer } from '@/display/webgl-renderer.ts';
import { CanvasRenderer } from '@/display/canvas-renderer.ts';
import { FloppySound } from '@/plus3/floppy-sound.ts';
import { PALETTES, SCREEN_WIDTH, SCREEN_HEIGHT } from '@/cores/ula.ts';
import { saveSZX, saveSZXSync } from '@/snapshot/szx.ts';
import { saveZ80 } from '@/snapshot/z80format.ts';
import { parseTZX } from '@/tape/tzx.ts';
import type { TapeBlock } from '@/tape/tap.ts';
import { parseDSK, serializeDSK, type DskImage } from '@/plus3/dsk.ts';
import { parseMgt, serializeMgt, blankMgtDisk, mgtExtFromName } from '@/plus3/mgt-image.ts';
import { loadSZX, applySZXPaging } from '@/snapshot/szx.ts';
import { readCpcSnaModel, applyCpcSna, saveCpcSna } from '@/snapshot/cpc-sna.ts';
import {
  clearLastFile, clearDisk, restoreTape, restoreDisk, dbSave, dbLoad,
  persistPlusDDisk, restorePlusDDisk, clearPlusDDisk,
  persistMicrodrive, restoreMicrodrive, clearMicrodrive,
} from '@/store/persistence.ts';
import { microdriveSlots, setMicrodriveSlot, clearMicrodriveSlot } from '@/state/microdrive-state.ts';
import * as settings from '@/store/settings.ts';
import { decideFocusPause } from '@/focus-pause.ts';
import { variantForModel, variantLabel, romFilename } from '@/peripherals/multiface.ts';
import { onFrame, updateRegsOnce, resetSpeedTracking, resetLedActivity, forceSpeedUpdate } from '@/frame-bridge.ts';
export { fontDataHash, updateFontPreview, loadFontStore, saveFontStore, capturedFontData } from '@/frame-bridge.ts';
export type { FontEntry } from '@/frame-bridge.ts';

// Managers
import { ROMManager } from '@/managers/rom-manager.ts';
import { MediaManager, type MediaLoadCallbacks } from '@/managers/media-manager.ts';
import { DebugManager, type TraceMode } from '@/managers/debug-manager.ts';

// Create manager instances
const romManager = new ROMManager();
const mediaManager = new MediaManager();
const debugManager = new DebugManager();

// Re-export TraceMode for compatibility
export type { TraceMode };

// ── State (re-exported from feature modules) ───────────────────────────

// Machine state — import everything, then re-export below
import {
  statusText,
  romStatusText,
  currentModel,
  emulationPaused,
  turboMode,
  clockSpeedText,
  saveModel,
  setStatusText,
  setRomStatusText,
  setCurrentModel,
  setEmulationPaused,
  setTurboMode,
  setClockSpeedText,
  multifaceRomFailed,
  vtx5000RomFailed,
  paradosRomFailed,
  plusDRomFailed,
  interface1RomFailed,
  setMultifaceRomFailed,
  setVtx5000RomFailed,
  setParadosRomFailed,
  setPlusDRomFailed,
  setInterface1RomFailed,
} from '@/state/machine-state.ts';

import {
  tapeLoaded,
  tapeBlocks,
  tapePosition,
  tapePaused,
  tapePlaying,
  tapeName,
  setTapeLoaded,
  setTapeName,
  setTapeBlocks,
  setTapePosition,
  setTapePaused,
  setTapePlaying,
} from '@/state/tape-state.ts';

import {
  currentDiskInfo, currentDiskName, currentDiskInfoB, currentDiskNameB,
  driveAStatus, driveBStatus, diskInfoHtml, driveHtml,
  setCurrentDiskInfo, setCurrentDiskName, setCurrentDiskInfoB, setCurrentDiskNameB,
  setDriveAStatus, setDriveBStatus, setDiskInfoHtml, setDriveHtml,
  currentDiskInfoC, currentDiskNameC, currentDiskInfoD, currentDiskNameD,
  driveCStatus, driveDStatus,
  setCurrentDiskInfoC, setCurrentDiskNameC, setCurrentDiskInfoD, setCurrentDiskNameD,
  setDriveCStatus, setDriveDStatus,
  diskSideA, setDiskSideA, diskSideB, setDiskSideB,
} from '@/state/disk-state.ts';

import {
  regsHtml, regsRev, sysvarHtml, sysvarRev,
  basicHtml, basicVarsHtml, banksHtml, disasmText, tracing,
  trapLogHtml, showTrapLog,
  setRegsHtml, setRegsRev, setSysvarHtml, setSysvarRev,
  setBasicHtml, setBasicVarsHtml, setBanksHtml, setDisasmText, setTracing,
  setTrapLogHtml, setShowTrapLog,
} from '@/state/debug-state.ts';

import {
  ledKbd, ledKemp, ledMouse, ledEar, ledLoad, ledTapeTurbo,
  ledDsk, ledBeep, ledAy, ledRainbow, ledText,
  transcribeMode, transcribeText, transcribeHtml, transcribeGrid,
  setLedKbd, setLedKemp, setLedMouse, setLedEar, setLedLoad, setLedTapeTurbo,
  setLedDsk, setLedBeep, setLedAy, setLedRainbow, setLedText,
  setTranscribeMode, setTranscribeText, setTranscribeHtml, setTranscribeGrid,
} from '@/state/activity-state.ts';

// Re-export machine state
export { statusText, romStatusText, currentModel, emulationPaused, turboMode, clockSpeedText, saveModel };
export { setStatusText, setRomStatusText, setCurrentModel, setEmulationPaused, setTurboMode, setClockSpeedText };
export { multifaceRomFailed, vtx5000RomFailed, paradosRomFailed, plusDRomFailed, interface1RomFailed };

// Re-export tape state
export { tapeLoaded, tapeBlocks, tapePosition, tapePaused, tapePlaying, tapeName };
export { setTapeLoaded, setTapeName, setTapeBlocks, setTapePosition, setTapePaused, setTapePlaying };

// Re-export disk state
export { currentDiskInfo, currentDiskName, currentDiskInfoB, currentDiskNameB, driveAStatus, driveBStatus, diskInfoHtml, driveHtml };
export { currentDiskInfoC, currentDiskNameC, currentDiskInfoD, currentDiskNameD, driveCStatus, driveDStatus };
export { diskSideA, diskSideB };
export { setCurrentDiskInfo, setCurrentDiskName, setCurrentDiskInfoB, setCurrentDiskNameB, setDriveAStatus, setDriveBStatus, setDiskInfoHtml, setDriveHtml };
export { setCurrentDiskInfoC, setCurrentDiskNameC, setCurrentDiskInfoD, setCurrentDiskNameD, setDriveCStatus, setDriveDStatus };

// Re-export debug state
export { regsHtml, regsRev, sysvarHtml, sysvarRev, basicHtml, basicVarsHtml, banksHtml, disasmText, tracing, trapLogHtml, showTrapLog };
export { setRegsHtml, setRegsRev, setSysvarHtml, setSysvarRev, setBasicHtml, setBasicVarsHtml, setBanksHtml, setDisasmText, setTracing, setTrapLogHtml, setShowTrapLog };

// Re-export activity state
export { ledKbd, ledKemp, ledMouse, ledEar, ledLoad, ledTapeTurbo, ledDsk, ledBeep, ledAy, ledRainbow, ledText, transcribeMode, transcribeText, transcribeHtml, transcribeGrid };
export { setLedKbd, setLedKemp, setLedMouse, setLedEar, setLedLoad, setLedTapeTurbo, setLedDsk, setLedBeep, setLedAy, setLedRainbow, setLedText, setTranscribeMode, setTranscribeText, setTranscribeHtml, setTranscribeGrid };

// ── Non-signal state (plain variables) ──────────────────────────────────

/** The active machine (Spectrum or CPC). Canonical handle for lifecycle/driver. */
export let machine: Machine | null = null;
/** Narrowed view of `machine` when it is a Spectrum, else null. Spectrum-only
 *  code paths (tape, Multiface, VTX, ULA, snapshots) use this and no-op on CPC. */
export let spectrum: Spectrum | null = null;
export let romData: Uint8Array | null = null;
export let floppySound: FloppySound | null = null;
export let canvasEl: HTMLCanvasElement | null = null;

/** A loaded tape parked while another machine family is active. The Spectrum and
 *  CPC decks are kept independent: switching ZX↔CPC stashes the outgoing tape
 *  under its family and restores the incoming family's own tape (if any), so one
 *  system's tape never turns up on the other. Same-family switches (e.g.
 *  48K→128K) round-trip through the same stash and so keep the tape as before. */
interface TapeStash {
  blocks: TapeBlock[];
  position: number;
  paused: boolean;
  name: string;
}
let spectrumTapeStash: TapeStash | null = null;
let cpcTapeStash: TapeStash | null = null;



// ── ROM management (via ROMManager) ─────────────────────────────────────

// Re-export ROMEntry type for compatibility
export type { ROMEntry } from '@/managers/rom-manager.ts';

/** Persist a ROM to cache and storage (delegates to ROMManager) */
export async function persistROM(model: MachineModel, data: Uint8Array, label: string): Promise<void> {
  await romManager.persistROM(model, data, label);
}

/** Restore a ROM from cache (delegates to ROMManager) */
export async function restoreROM(model: MachineModel) {
  return await romManager.restoreROM(model);
}

/** Fetch default ROM from CDN (delegates to ROMManager) */
export async function fetchDefaultROM(model: MachineModel) {
  return await romManager.fetchDefaultROM(model, setStatus);
}

// ── Actions ─────────────────────────────────────────────────────────────

export function setStatus(msg: string): void {
  setStatusText(msg);
}

export function setRomStatus(msg: string): void {
  setRomStatusText(msg);
}

function createDisplay(el: HTMLCanvasElement, w: number, h: number) {
  // The CPC frame buffer is 2× oversampled horizontally (16 Gate-Array pixel
  // clocks per character); display it at half width to restore a ~4:3 pixel
  // aspect and keep the Scale steps consistent with the Spectrum.
  const pixelAspectX = isCpcModel(currentModel()) ? 0.5 : 1;
  if (settings.renderer() === 'webgl' && settings.webglAvailable()) {
    try {
      return new WebGLRenderer(el, w, h, pixelAspectX);
    } catch (err) {
      console.warn('WebGL unavailable, falling back to Canvas:', err);
      settings.setWebglAvailable(false);
      settings.setRenderer('canvas');
      settings.persistSetting('renderer', 'canvas');
      setStatus('WebGL unavailable — using Canvas renderer');
    }
  }
  return new CanvasRenderer(el, w, h, pixelAspectX);
}

export function setCanvas(el: HTMLCanvasElement): void {
  canvasEl = el;
  if (machine) {
    // Swap display without rebuilding machine (e.g. renderer switch)
    const s = asSpectrum(machine);
    const w = s ? s.ula.screenWidth : CPC_SCREEN_WIDTH;
    const h = s ? s.ula.screenHeight : CPC_SCREEN_HEIGHT;
    machine.display = createDisplay(el, w, h);
    applyDisplaySettings();
  }
}

export function applyDisplaySettings(): void {
  if (!machine) return;
  machine.setBorderSize(settings.borderSize() as 0 | 1 | 2);
  const d = machine.display;
  if (d) {
    d.setScale(settings.scale());
    d.setBrightness(settings.brightness() / 50);
    d.setContrast(settings.contrast() / 50);
    d.setSmoothing(settings.smoothing() / 100);
    d.setCurvature(settings.curvature() / 100 * 0.15);
    d.setScanlines(settings.scanlines() / 100);
    d.setMaskType(settings.maskType());
    d.setDotPitch(settings.dotPitch() / 10);
    d.setCurvatureMode(settings.curvatureMode());
    d.setNoise(settings.noise() / 100);
    d.setScalingMode(settings.scalingMode());
  }
  const s = asSpectrum(machine);
  if (s) {
    s.ula.palette = PALETTES[settings.colorMap()];
    s['audio'].setVolume(settings.volume() / 100);
    const mix = settings.ayMix() / 100;
    s.mixer.beeperGain = Math.min(1, 2 * (1 - mix));
    s.mixer.ayGain = Math.min(1, 2 * mix);
    s.tapeFastRom = settings.tapeFastRom();
    s.tapeTurbo = settings.tapeTurbo();
    s.tapeSoundEnabled = settings.tapeSoundEnabled();
    s.scanlineAccuracy = settings.scanlineAccuracy();
  } else {
    // CPC: AY-only, no beeper mixer. Volume + Fast ROM + Turbo while loading
    // (no Fast edge — the CPC has no Spectrum-style loader detector).
    const c = machine as CpcMachine;
    c.gateArray.palette = CPC_PALETTES[settings.cpcColorMap()];
    c.audio.setVolume(settings.volume() / 100);
    c.tapeFastRom = settings.tapeFastRom();
    c.tapeTurbo = settings.tapeTurbo();
  }
}

export async function createMachine(): Promise<boolean> {
  if (!canvasEl) return false;

  // Stash the outgoing machine's tape under its own family so a CPC tape and a
  // Spectrum tape stay independent (see TapeStash). The deck is read off the
  // live machine; the name comes from the UI signal that mirrors it.
  if (machine) {
    const stash: TapeStash = {
      blocks: [...machine.tape.blocks],
      position: machine.tape.position,
      paused: machine.tape.paused,
      name: tapeName(),
    };
    if (asCpc(machine)) cpcTapeStash = stash;
    else spectrumTapeStash = stash;
  }

  if (machine) {
    machine.destroy();
  }

  const model = currentModel();
  const cpc = isCpcModel(model);
  const [w, h] = cpc ? [CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT] : [SCREEN_WIDTH, SCREEN_HEIGHT];
  const display = canvasEl ? createDisplay(canvasEl, w, h) : null;
  machine = cpc
    ? new CpcMachine(model as CpcModel, display)
    : new Spectrum(model as SpectrumModel, display);
  spectrum = asSpectrum(machine);
  machine.onStatus = (msg: string) => setStatus(msg);
  machine.onFrame = onFrame;
  applyDisplaySettings();
  resetSpeedTracking();
  resetLedActivity();   // drop any LED hold state carried over from a prior machine

  // Spectrum-only peripherals (VTX-5000, Multiface) BEFORE loadROM/reset so
  // their ROMs are paged when loadROM/reset run.
  if (spectrum) {
    spectrum.vtx5000.enabled = settings.vtx5000Enabled();
    if (spectrum.vtx5000.enabled) {
      await loadVTX5000ROM(spectrum);
    }
    spectrum.multiface.variant = variantForModel(model as SpectrumModel);
    spectrum.multiface.enabled = settings.multifaceEnabled();
    if (spectrum.multiface.enabled) {
      loadMultifaceROM(spectrum).catch(err => console.warn('MF ROM load failed:', err));
    }
    // MGT +D (48K/128K/+2). Load the ROM before reset so the shadow ROM is
    // present when reset() pages it in to boot G+DOS.
    spectrum.mgtPlusD.enabled = settings.plusDEnabled() && isPlusDCapable(model);
    if (spectrum.mgtPlusD.enabled) {
      await loadPlusDROM(spectrum);
      spectrum.mgtPlusD.fdc.writeProtect[0] = settings.writeProtectC();
      spectrum.mgtPlusD.fdc.writeProtect[1] = settings.writeProtectD();
    }
    // ZX Interface 1 (48K/128K/+2). Load the ROM before reset so the M1 fetch
    // traps can page it in once the main ROM starts running.
    spectrum.interface1.enabled = settings.interface1Enabled() && isInterface1Capable(model);
    if (spectrum.interface1.enabled) {
      await loadInterface1ROM(spectrum);
    }
  }

  // CPC Multiface Two — shares the 'multiface' enable setting.
  const cpcForMf = asCpc(machine);
  if (cpcForMf) {
    cpcForMf.multiface.enabled = settings.multifaceEnabled();
    if (cpcForMf.multiface.enabled) {
      await loadCpcMultifaceROM(cpcForMf);
    }
  }

  let hmrRestored = false;
  if (romData) {
    machine.loadROM(romData);
    machine.reset();

    // ParaDOS overlay: swap AMSDOS (upper ROM 7) for ParaDOS on a disk-capable
    // CPC, before boot so the firmware's ROM scan initialises it.
    if (cpc && (machine as CpcMachine).config.hasFDC && settings.cpcParados()) {
      await loadParadosROM(machine as CpcMachine);
    }

    // HMR state restore is Spectrum-only (snapshot formats); CPC starts fresh.
    if (spectrum) hmrRestored = await restoreHMRState();
    if (!hmrRestored) {
      machine.start();
    }
  }

  // Apply saved AY stereo mode + DC blocking (both machines have an AY)
  const savedAyStereo = settings.ayStereo() as import('@/cores/ay-3-8910.ts').AYStereoMode;
  machine.ay.setStereoMode(savedAyStereo);
  machine.ay.dcBlocking = settings.ayDcBlock();
  machine.ay.antialias = settings.ayAntialias() as import('@/cores/ay-3-8910.ts').AYAntialiasMode;

  // Disk write-protect + floppy sound (Spectrum +3 or any CPC with a controller)
  setCurrentDiskInfo(null);
  setCurrentDiskName('');
  setCurrentDiskInfoB(null);
  setCurrentDiskNameB('');
  const hasFDC = spectrum ? spectrum.variant.hasFDC : (machine as CpcMachine).config.hasFDC;
  if (hasFDC) {
    machine.fdc.writeProtect[0] = settings.writeProtectA();
    machine.fdc.writeProtect[1] = settings.writeProtectB();
    machine.fdc.forceReady[1] = settings.driveBForceReady();
    if (!floppySound) floppySound = new FloppySound();
    floppySound.reset();
  } else {
    floppySound?.destroy();
    floppySound = null;
  }

  // Restore the tape stashed for the NEW machine's family (if any). Switching
  // across families therefore surfaces that family's own tape, not the one the
  // other system had loaded.
  const stash = cpc ? cpcTapeStash : spectrumTapeStash;
  if (machine && stash && stash.blocks.length > 0) {
    machine.tape.blocks = stash.blocks;
    machine.tape.position = stash.position;
    machine.tape.paused = stash.paused;
    batch(() => {
      setTapeLoaded(true);
      setTapeName(stash.name);
      setTapeBlocks([...stash.blocks]);
      setTapePosition(stash.position);
      setTapePaused(stash.paused);
      setTapePlaying(false);
      setTurboMode(false);
    });
  } else {
    batch(() => {
      setTapeLoaded(false);
      setTapeBlocks([]);
      setTapePosition(0);
      setTapePaused(true);
      setTapePlaying(false);
      setTurboMode(false);
    });
  }

  unpause();
  return hmrRestored;
}

export function createMachineSync(): void {
  createMachine().catch(err => console.error('createMachine error:', err));
}

export function unpause(): void {
  setEmulationPaused(false);
}

function clearDebugPanels(): void {
  setDisasmText('');
  setSysvarHtml('');
  setBasicHtml('');
  setBasicVarsHtml('');
}

// True while emulation is paused solely because the tab/window lost focus, so
// syncFocusPause() knows it may auto-resume. Any manual pause/unpause clears it.
let autoPausedByBlur = false;

/**
 * Pause when the tab is hidden or the window loses focus; resume on return.
 * Called from focus/blur/visibilitychange listeners. Only ever resumes a
 * machine this logic itself paused — a manual or debugger pause is untouched.
 */
export function syncFocusPause(): void {
  if (!machine) return;
  const active = document.visibilityState === 'visible' && document.hasFocus();
  const action = decideFocusPause({
    active,
    settingOn: settings.pauseOnFocusLost(),
    paused: emulationPaused(),
    autoPaused: autoPausedByBlur,
  });
  if (action === 'pause') {
    machine.stop();
    updateRegsOnce();
    setEmulationPaused(true);
    autoPausedByBlur = true;
  } else if (action === 'resume') {
    autoPausedByBlur = false;
    clearDebugPanels();
    machine.start();
    setEmulationPaused(false);
  }
}

export function togglePause(): void {
  if (!machine) return;
  autoPausedByBlur = false;
  if (emulationPaused()) {
    clearDebugPanels();
    machine.start();
  } else {
    machine.stop();
    updateRegsOnce();
  }
  setEmulationPaused(!emulationPaused());
}

export function stepInto(): void {
  if (!machine) return;
  if (!emulationPaused()) {
    machine.stop();
    setEmulationPaused(true);
  }
  debugManager.stepInto(machine, updateRegsOnce);
}

export function stepOver(): void {
  if (!machine) return;
  if (!emulationPaused()) {
    machine.stop();
    setEmulationPaused(true);
  }
  debugManager.stepOver(machine, updateRegsOnce);
}

export function stepOut(): void {
  if (!machine) return;
  if (!emulationPaused()) {
    machine.stop();
    setEmulationPaused(true);
  }
  debugManager.stepOut(machine, updateRegsOnce);
}

export function stepFrame(): void {
  if (!machine) return;
  if (!emulationPaused()) {
    machine.stop();
    setEmulationPaused(true);
  }
  debugManager.stepFrame(machine, updateRegsOnce);
}

export function resetMachine(): void {
  floppySound?.reset();
  if (machine) {
    machine.turbo = false;
    setTurboMode(false);
    machine.reset();
    if (romData) machine.start();
    unpause();
  }
  if (transcribeMode() !== 'off') {
    setTranscribeMode('off');
  }
  clearLastFile();
}

/** ROM address where each model idles waiting for a key — the deterministic
 *  point to fire the auto-boot loader (found by tracing each ROM's key-wait). */
function bootWaitPc(model: MachineModel): number {
  if (model === '+2A' || model === '+3') return 0x1875;   // +2A/+3 menu wait loop (BIT 5,(HL) / JR Z,1875)
  if (model === '128k' || model === '+2') return 0x0E65;  // 128K/+2 menu wait loop
  return 0x15DE;                                           // 48K editor WAIT-KEY
}

/**
 * Reset the machine and arm a one-shot trap to kick off its loader once the ROM
 * reaches its menu/editor key-wait loop — deterministic, frame-exact (no
 * wall-clock race). Used by the software library's one-click play:
 *  - 'menu'   → press Enter on the 128K/+2/+2A/+3 boot menu (default = Loader),
 *               loading the tape (128K) or disk in A: (+3).
 *  - 'rom48k' → jump the 48K ROM to LD-BYTES (0x0556); the mounted tape loads
 *               via the fast-ROM trap at 0x056C.
 *
 * The media must already be mounted.
 */
export function autoBootLoad(method: 'menu' | 'rom48k'): void {
  resetMachine();
  if (!spectrum) return;
  spectrum.bootTrapKind = method;
  spectrum.bootTrapPc = bootWaitPc(currentModel());
}

export function toggleTurbo(): void {
  if (!machine) return;
  machine.turbo = !machine.turbo;
  setTurboMode(machine.turbo);
  forceSpeedUpdate();
}

export function toggleBreakpoint(addr: number): void {
  if (!machine) return;
  debugManager.toggleBreakpoint(machine, addr, setStatus, updateRegsOnce);
}

export function runTo(addr: number): void {
  if (!machine) return;
  debugManager.runTo(machine, addr, emulationPaused(), () => {
    clearDebugPanels();
    setEmulationPaused(false);
  });
}

export function getPendingRunTo(): number {
  return debugManager.getPendingRunTo();
}

export function clearPendingRunTo(): void {
  debugManager.clearPendingRunTo();
}

export function copyCpuState(): void {
  if (!machine) return;
  debugManager.copyCpuState(machine, setStatus);
}

export function startTrace(mode: TraceMode = 'full'): void {
  if (!machine) return;
  debugManager.startTrace(machine, mode, () => setTracing(true));
}

export function stopTrace(): void {
  if (!machine) return;
  debugManager.stopTrace(machine, (text, lineCount) => {
    setTracing(false);
    navigator.clipboard.writeText(text);
    setStatus(`Trace copied to clipboard (${lineCount.toLocaleString()} lines)`);
  });
}

// ── Model switching ─────────────────────────────────────────────────────

/**
 * Returns the ROM model key to use when loading ROMs for a given machine model.
 * When "+3 V4.1 ROMs" is enabled the +3 machine uses the +2A ROM set.
 */
function effectiveROMModel(model: MachineModel): MachineModel {
  return model === '+3' && settings.plus3V41Roms() ? '+2A' : model;
}

export async function switchModel(model: MachineModel): Promise<void> {
  setCurrentModel(model);
  saveModel(model);

  // The +D is a model-independent peripheral: preserve any mounted +D disks
  // across the rebuild so a model switch doesn't leave the new WD1772 empty
  // (which G+DOS reports as "CHECK DISC"). createMachine() builds a fresh
  // machine, so capture the images first and re-insert them after.
  const carriedPlusD = spectrum?.mgtPlusD.enabled
    ? [spectrum.mgtPlusD.fdc.getDiskImage(0), spectrum.mgtPlusD.fdc.getDiskImage(1)]
    : null;

  const romModel = effectiveROMModel(model);
  let entry = await restoreROM(romModel);
  if (!entry) entry = await fetchDefaultROM(romModel);

  if (entry) {
    romData = entry.data;
    setRomStatus('');
  } else {
    romData = null;
    setRomStatus('');
  }

  await createMachine();

  if (carriedPlusD && spectrum?.mgtPlusD.enabled) {
    if (carriedPlusD[0]) spectrum.loadPlusDDisk(carriedPlusD[0], 0);
    if (carriedPlusD[1]) spectrum.loadPlusDDisk(carriedPlusD[1], 1);
  }
}

// ── ROM loading ─────────────────────────────────────────────────────────

export async function applyROM(data: Uint8Array, fileLabel: string): Promise<void> {
  romData = data;

  // Spectrum ROM-image drop. A CPC active here falls back to a 128K default.
  const cur: SpectrumModel = isCpcModel(currentModel()) ? '128k' : currentModel() as SpectrumModel;
  let detectedModel: SpectrumModel;
  if (data.length >= 65536) {
    detectedModel = isPlus2AClass(cur) ? cur : '+2A';
  } else if (data.length >= 32768) {
    detectedModel = is128kClass(cur) ? cur : '128k';
  } else if (data.length >= 16384) {
    detectedModel = '48k';
  } else {
    setStatus(`ROM too small (${data.length} bytes)`);
    return;
  }

  setCurrentModel(detectedModel);
  saveModel(detectedModel);

  await persistROM(detectedModel, data, fileLabel);
  setRomStatus('');

  await createMachine();
}

export async function loadRomFiles(files: Array<{ name: string; data: Uint8Array }>): Promise<void> {
  if (files.length === 0) return;

  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const sizes = sorted.map(f => f.data.length);

  if (sorted.length === 1 && sizes[0] === 16384) {
  } else if (sorted.length === 1 && sizes[0] === 32768) {
  } else if (sorted.length === 1 && sizes[0] === 65536) {
  } else if (sorted.length === 2 && sizes[0] === 16384 && sizes[1] === 16384) {
  } else if (sorted.length === 4 && sizes.every(s => s === 16384)) {
  } else {
    const sizeList = sizes.map(s => `${s}b`).join(', ');
    setStatus(`Invalid ROM: expected 1×16KB, 1×32KB, 1×64KB, 2×16KB, or 4×16KB — got ${sorted.length} file(s) (${sizeList})`);
    return;
  }

  const totalLen = sizes.reduce((s, n) => s + n, 0);
  const data = new Uint8Array(totalLen);
  let offset = 0;
  for (const f of sorted) {
    data.set(f.data, offset);
    offset += f.data.length;
  }
  const label = sorted.map(f => f.name).join(' + ');
  await applyROM(data, label);
}

// ── Snapshot loading ────────────────────────────────────────────────────

/** Try to switch to a 128K-class ROM. createMachine() destroys the old
 *  machine and installs a new one, so hand the caller the new Spectrum (and
 *  its model) to re-bind to. Returns null if no 128K ROM is available. */
async function ensure128kROM(): Promise<{ spectrum: Spectrum; model: SpectrumModel } | null> {
  const models: SpectrumModel[] = ['128k', '+2', '+2A', '+3'];
  for (const model of models) {
    const entry = await restoreROM(model);
    if (entry) {
      setCurrentModel(model);
      romData = entry.data;
      setRomStatus('');
      await createMachine();
      return spectrum ? { spectrum, model } : null;
    }
  }
  return null;
}

/** Build media callbacks for the MediaManager */
function buildMediaCallbacks(): MediaLoadCallbacks {
  return {
    onStatus: setStatus,
    onTapeLoaded: (blocks, filename) => {
      batch(() => {
        setTapeLoaded(true);
        setTapeName(filename);
        setTapeBlocks([...blocks]);
        setTapePosition(0);
        setTapePaused(true);
        setTapePlaying(true);
      });
    },
    onDiskLoaded: (image, filename, unit) => {
      if (unit === 0) {
        setCurrentDiskInfo(image);
        setCurrentDiskName(filename);
      } else {
        setCurrentDiskInfoB(image);
        setCurrentDiskNameB(filename);
      }
    },
    onSnapshotLoaded: (_filename) => {
      // No special action needed beyond what MediaManager already does
    },
    unpause,
    ensure128kROM,
    loadExtracted: (fileData, name, fileUnit) => loadFile(fileData, name, fileUnit),
  };
}


// ── Tape/Disk loading (via MediaManager) ───────────────────────────────

export function applyTape(data: Uint8Array, filename: string): void {
  if (!machine) { setStatus('Load a ROM first'); return; }

  mediaManager.applyTape(machine, data, filename, {
    onStatus: setStatus,
    onTapeLoaded: (blocks, filename) => {
      batch(() => {
        setTapeLoaded(true);
        setTapeName(filename);
        setTapeBlocks([...blocks]);
        setTapePosition(0);
        setTapePaused(true);
        setTapePlaying(true);
      });
    },
    unpause,
  });
}

// ── File routing ────────────────────────────────────────────────────────

/**
 * File extensions the current machine can load, for the Load picker filter.
 * CPC uses .sna snapshots and .cdt cassettes; the Spectrum uses its own snapshot
 * + tape formats and .zip archives. `.dsk` is offered only when the active
 * machine actually has a floppy controller (+3, or a CPC 664/6128).
 */
export function loadableExtensions(): string[] {
  const cpc = asCpc(machine);
  if (cpc) {
    const exts = ['.sna', '.cdt'];
    if (cpc.config.hasFDC) exts.push('.dsk');
    return exts;
  }
  // Spectrum (and the no-machine default).
  const exts = ['.sna', '.z80', '.szx', '.sp', '.tap', '.tzx'];
  if (spectrum?.variant.hasFDC) exts.push('.dsk');
  if (spectrum && isInterface1Capable(currentModel())) exts.push('.mdr', '.mdv');
  exts.push('.zip');
  return exts;
}

export async function loadFile(data: Uint8Array, filename: string, unit?: number): Promise<void> {
  // CPC: .dsk disk images into the shared uPD765A, or .cdt/.tzx/.tap cassettes.
  const cpc = asCpc(machine);
  if (cpc) {
    if (/\.(cdt|tzx|tap)$/i.test(filename)) {
      applyTape(data, filename);
      return;
    }
    if (/\.sna$/i.test(filename)) {
      await loadCpcSnapshot(data, filename);
      return;
    }
    if (!/\.dsk$/i.test(filename)) { setStatus('CPC accepts .sna, .dsk, .cdt, .tzx and .tap files'); return; }
    cpc.stop();
    try {
      const image = parseDSK(data);
      const u = unit ?? 0;
      cpc.loadDisk(image, u);
      if (u === 0) { setCurrentDiskInfo(image); setCurrentDiskName(filename); }
      else { setCurrentDiskInfoB(image); setCurrentDiskNameB(filename); }
      setStatus(`Disk ${u === 0 ? 'A' : 'B'}: loaded: ${filename}`);
    } catch (e) {
      setStatus(`DSK error: ${(e as Error).message}`);
    } finally {
      cpc.start();
    }
    return;
  }
  if (!spectrum) { setStatus('Load a ROM first'); return; }
  // MGT +D images route to the WD1772, not the media manager's +3 DSK path.
  if (/\.(mgt|img)$/i.test(filename)) {
    loadPlusDDisk(data, filename, unit ?? 0);
    return;
  }
  // ZX Interface 1 microdrive cartridges route to the IF1, like the +D above.
  if (/\.(mdr|mdv)$/i.test(filename)) {
    loadMicrodrive(data, filename, unit ?? 0);
    return;
  }
  await mediaManager.loadFile(spectrum, data, filename, currentModel() as SpectrumModel, buildMediaCallbacks(), unit);
}

// ── Save snapshot ───────────────────────────────────────────────────────

function downloadFile(data: Uint8Array, filename: string): void {
  const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Load a CPC `.SNA`. Auto-switches the running machine to the snapshot's model
 * (464/664/6128 differ in RAM size and ROM set) before applying state.
 */
async function loadCpcSnapshot(data: Uint8Array, filename: string): Promise<void> {
  let info;
  try {
    info = readCpcSnaModel(data);
  } catch (e) {
    setStatus(`SNA error: ${(e as Error).message}`);
    return;
  }

  if (info.model !== currentModel()) {
    await switchModel(info.model);   // rebuilds + starts the machine with the right ROM
  }

  const cpc = asCpc(machine);
  if (!cpc) { setStatus('SNA load needs a CPC machine'); return; }

  cpc.stop();
  try {
    applyCpcSna(data, cpc);
    setStatus(`Loaded ${info.model} SNA v${info.version}: ${filename}`);
  } catch (e) {
    setStatus(`SNA error: ${(e as Error).message}`);
  } finally {
    cpc.start();
  }
}

/** Save the running CPC as a `.SNA` (v2 = flat, v3 = RLE-compressed). */
export function saveCpcSnapshot(version: 2 | 3): void {
  const cpc = asCpc(machine);
  if (!cpc) { setStatus('No CPC running'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) cpc.stop();

  const data = saveCpcSna(cpc, version);
  downloadFile(data, `zx84-${cpc.model}.sna`);

  if (!wasPaused) cpc.start();
  setStatus(`Saved zx84-${cpc.model}.sna (v${version})`);
}

export async function saveSnapshot(format: 'z80' | 'szx' = 'szx'): Promise<void> {
  if (!spectrum) { setStatus('No machine running'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) spectrum.stop();

  // spectrum non-null ⇒ a Spectrum model is active (snapshots are Spectrum-only).
  const model = currentModel() as SpectrumModel;
  let data: Uint8Array;

  if (format === 'szx') {
    const ayRegs = spectrum.ay.getRegisters();
    data = await saveSZX(spectrum.cpu, spectrum.memory, spectrum.ula.borderColor, model, spectrum.contention.frameStartTStates, ayRegs, spectrum.ay.selectedReg);
  } else {
    // .z80 format
    data = saveZ80(spectrum.cpu, spectrum.memory, spectrum.ula.borderColor, spectrum.variant.hasBanking, spectrum.ay.getRegisters(), spectrum.ay.selectedReg);
  }

  const filename = `zx84-${model.replace('+', 'plus')}.${format}`;

  downloadFile(data, filename);

  if (!wasPaused) spectrum.start();
  setStatus(`Saved ${filename}`);
}

export function saveScreenshot(format: 'png' | 'scr'): void {
  if (!machine) { setStatus('No machine running'); return; }

  if (format === 'scr') {
    // .scr = raw 6912 bytes from 0x4000 (6144 pixels + 768 attrs) — Spectrum-only.
    if (!spectrum) { setStatus('.scr is a Spectrum format'); return; }
    const screenData = spectrum.memory.getRamBank(5).slice(0, 6912);
    downloadFile(screenData, 'screen.scr');
    setStatus('Saved screen.scr');
  } else {
    // PNG export via canvas (works for any machine with a display).
    if (!machine.display) { setStatus('No display available'); return; }
    const canvas = machine.display['canvas'] as HTMLCanvasElement;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'screen.png';
      a.click();
      URL.revokeObjectURL(url);
      setStatus('Saved screen.png');
    });
  }
}

export function saveRAM(): void {
  if (!spectrum) { setStatus('No machine running'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) spectrum.stop();

  // Check if RAM is at 0x0000 (special paging mode on +2A/+3)
  const mem = spectrum.memory;
  const startAddr = mem.specialPaging ? 0 : 0x4000;
  const ramData = spectrum.memory.readBlock(startAddr, 0x10000 - startAddr);

  const filename = startAddr === 0 ? 'ram-64k.bin' : 'ram-48k.bin';
  downloadFile(ramData, filename);

  if (!wasPaused) spectrum.start();
  setStatus(`Saved ${filename}`);
}

// ── Tape transport ──────────────────────────────────────────────────────

export function tapeRewind(): void {
  if (!machine) return;
  machine.tape.rewind();
  setTapePosition(0);
}

export function tapePrev(): void {
  if (!machine) return;
  if (machine.tape.position > 0) machine.tape.position--;
  setTapePosition(machine.tape.position);
}

export function tapeTogglePlay(): void {
  if (!machine) return;
  const spec = asSpectrum(machine);
  if (machine.tape.playing) {
    // User-initiated stop — block the Spectrum LoaderDetector from auto-
    // restarting on post-load keyboard polling. Cleared on the next manual play.
    if (spec) spec.loaderDetector.userOverride = true;
    machine.tape.stopPlayback();
    setTapePlaying(false);
  } else {
    if (spec) spec.loaderDetector.userOverride = false;
    machine.tape.paused = false;
    machine.tape.startPlayback();
    setTapePaused(false);
    setTapePlaying(true);
  }
}

export function tapeTogglePause(): void {
  if (!machine) return;
  machine.tape.paused = !machine.tape.paused;
  // Pausing is a user action — prevent the Spectrum LoaderDetector from auto-
  // resuming the tape via its 'start' event on post-load polling. Cleared
  // when the user unpauses.
  const spec = asSpectrum(machine);
  if (spec) spec.loaderDetector.userOverride = machine.tape.paused;
  setTapePaused(machine.tape.paused);
}

export function tapeNext(): void {
  if (!machine) return;
  if (machine.tape.position < machine.tape.blocks.length) machine.tape.position++;
  setTapePosition(machine.tape.position);
}

export function tapeSetPosition(pos: number): void {
  if (!machine) return;
  machine.tape.position = pos;
  setTapePosition(pos);
}

export function toggleAutoRewind(): void {
  settings.setTapeAutoRewind(!settings.tapeAutoRewind());
  settings.persistSetting('tape-auto-rewind', settings.tapeAutoRewind() ? 'on' : 'off');
}

export function ejectTape(): void {
  if (!machine) return;
  mediaManager.ejectTape(machine, () => {
    batch(() => {
      setTapeLoaded(false);
      setTapeName('');
      setTapeBlocks([]);
      setTapePosition(0);
      setTapePaused(true);
      setTapePlaying(false);
    });
  }, setStatus);
}

export function ejectDisk(unit: number = 0): void {
  if (!machine) return;
  const onEjected = (u: number) => {
    if (u === 0) {
      setCurrentDiskInfo(null);
      setCurrentDiskName('');
      setDiskInfoHtml('');
      setDiskSideA(0);
    } else {
      setCurrentDiskInfoB(null);
      setCurrentDiskNameB('');
      setDiskSideB(0);
    }
  };
  if (spectrum) {
    mediaManager.ejectDisk(spectrum, unit, onEjected, setStatus);
  } else {
    machine.fdc.ejectDisk(unit);
    clearDisk(unit);   // drop the persisted image so a hard refresh won't remount it
    onEjected(unit);
    setStatus(`Disk ${unit === 0 ? 'A' : 'B'}: ejected`);
  }
}

export function insertBlankDisk(image: DskImage, name: string, unit: number): void {
  if (!machine) return;
  machine.fdc.insertDisk(image, unit);
  if (unit === 0) {
    setCurrentDiskInfo(image);
    setCurrentDiskName(name);
  } else {
    setCurrentDiskInfoB(image);
    setCurrentDiskNameB(name);
  }
}

/**
 * Flip a combined "flippy" disk in drive `unit` (0 = A:, 1 = B:) to its other
 * side. A 3" disk held two independent single-sided 180K filesystems; turning it
 * over presents the second side to the (single-sided) drive head. We model that
 * by toggling the FDC's per-drive flipSide offset — the full two-sided image
 * stays mounted, so saving still writes both sides.
 */
export function flipDisk(unit: number): void {
  if (!machine) return;
  const phys = unit & 1;
  const image = machine.fdc.getDiskImage(phys);
  if (!image?.flippy) return;
  const newSide = machine.fdc.flipSide[phys] ^ 1;
  machine.fdc.flipSide[phys] = newSide;
  if (unit === 0) setDiskSideA(newSide); else setDiskSideB(newSide);
  setStatus(`Disk ${unit === 0 ? 'A' : 'B'}: flipped to Side ${newSide ? 'B' : 'A'}`);
}

export function saveDisk(unit: number): void {
  if (!machine) return;
  const image = machine.fdc.getDiskImage(unit);
  if (!image) { setStatus(`No disk in drive ${unit === 0 ? 'A' : 'B'}:`); return; }
  const name = unit === 0 ? currentDiskName() : currentDiskNameB();
  const filename = name.replace(/\.[^.]+$/, '') + '.dsk';
  downloadFile(serializeDSK(image), filename);
  machine.fdc.clearDirty(unit);   // the on-disk file now matches the image
}

/**
 * Download the currently loaded tape, byte-for-byte as it was loaded. The
 * verbatim original (TAP/TZX/CDT) is the same blob we persist for session
 * restore, so we read it back from storage rather than re-serialising blocks.
 */
export async function saveTape(): Promise<void> {
  const tape = await restoreTape();
  if (!tape) { setStatus('No tape to save'); return; }
  downloadFile(tape.data, tape.name);
}

export function loadDiskToUnit(data: Uint8Array, filename: string, unit: number): void {
  if (!machine) { setStatus('Load a ROM first'); return; }
  const onDiskLoaded = (image: DskImage, fname: string, u: number) => {
    if (u === 0) { setCurrentDiskInfo(image); setCurrentDiskName(fname); }
    else { setCurrentDiskInfoB(image); setCurrentDiskNameB(fname); }
  };
  const cpc = asCpc(machine);
  if (cpc) {
    try {
      const image = parseDSK(data);
      cpc.loadDisk(image, unit);
      onDiskLoaded(image, filename, unit);
      setStatus(`Disk ${unit === 0 ? 'A' : 'B'}: loaded: ${filename}`);
    } catch (e) {
      setStatus(`DSK error: ${(e as Error).message}`);
    }
    return;
  }
  mediaManager.loadDisk(spectrum!, data, filename, unit, { onStatus: setStatus, onDiskLoaded });
}

// ── MGT +D disk helpers (drives C/D = WD1772 units 0/1) ──────────────────

function setPlusDDiskState(unit: number, image: DskImage | null, name: string): void {
  if (unit === 0) { setCurrentDiskInfoC(image); setCurrentDiskNameC(name); }
  else { setCurrentDiskInfoD(image); setCurrentDiskNameD(name); }
}

/** Load a .mgt/.img image into a +D drive (unit 0/1 → C:/D:). */
export function loadPlusDDisk(data: Uint8Array, filename: string, unit: number): void {
  if (!spectrum) { setStatus('Load a ROM first'); return; }
  if (!spectrum.mgtPlusD.enabled) { setStatus('Enable the MGT +D in Hardware first'); return; }
  const image = parseMgt(data, mgtExtFromName(filename));
  if (!image) { setStatus(`Not a recognised +D image: ${filename}`); return; }
  spectrum.stop();
  try {
    spectrum.loadPlusDDisk(image, unit);
    setPlusDDiskState(unit, image, filename);
    persistPlusDDisk(unit, data, filename);   // survive a reload (see restoreMedia)
    setStatus(`+D disk ${unit === 0 ? 'C' : 'D'}: loaded: ${filename}`);
  } finally {
    spectrum.start();
  }
}

export function ejectPlusDDisk(unit: number): void {
  if (!spectrum) return;
  spectrum.mgtPlusD.fdc.ejectDisk(unit);
  clearPlusDDisk(unit);   // drop the persisted image so a hard refresh won't remount it
  setPlusDDiskState(unit, null, '');
  setStatus(`+D disk ${unit === 0 ? 'C' : 'D'}: ejected`);
}

export function insertBlankPlusDDisk(unit: number): void {
  if (!spectrum) return;
  const image = blankMgtDisk();
  spectrum.loadPlusDDisk(image, unit);
  setPlusDDiskState(unit, image, 'BLANK.mgt');
  persistPlusDDisk(unit, serializeMgt(image, 'mgt'), 'BLANK.mgt');   // survive a reload
}

export function savePlusDDisk(unit: number): void {
  if (!spectrum) return;
  const image = spectrum.mgtPlusD.fdc.getDiskImage(unit);
  if (!image) { setStatus(`No disk in +D drive ${unit === 0 ? 'C' : 'D'}:`); return; }
  const name = unit === 0 ? currentDiskNameC() : currentDiskNameD();
  const base = name.replace(/\.[^.]+$/, '') || 'plusd';
  downloadFile(serializeMgt(image, 'mgt'), `${base}.mgt`);
  spectrum.mgtPlusD.fdc.clearDirty(unit);   // the on-disk file now matches the image
}


// ── ZX Interface 1 microdrive helpers (drives 1-8 → units 0-7) ───────────

/** Mount an .mdr/.mdv cartridge into a microdrive (unit 0-7 → drive 1-8). */
export function loadMicrodrive(data: Uint8Array, filename: string, unit: number): void {
  if (!spectrum) { setStatus('Load a ROM first'); return; }
  if (!spectrum.interface1.enabled) { setStatus('Enable the ZX Interface 1 in Hardware first'); return; }
  try {
    const drive = spectrum.interface1.drives[unit];
    drive.loadMDR(data);
    setMicrodriveSlot(unit, { loaded: true, name: filename, writeProtected: drive.writeProtected, modified: false });
    // Persist for a reload; never let a storage error take down the mount.
    persistMicrodrive(unit, data, filename).catch((e) => console.warn('persistMicrodrive failed:', e));
    setStatus(`Microdrive ${unit + 1}: loaded: ${filename}`);
  } catch (e) {
    console.error('loadMicrodrive failed:', e);
    setStatus(`Microdrive error: ${(e as Error).message}`);
  }
}

export function ejectMicrodrive(unit: number): void {
  if (!spectrum) return;
  spectrum.interface1.drives[unit].eject();
  clearMicrodrive(unit);          // drop the persisted image so a refresh won't remount
  clearMicrodriveSlot(unit);
  setStatus(`Microdrive ${unit + 1}: ejected`);
}

export function insertBlankMicrodrive(unit: number, name = 'CART'): void {
  if (!spectrum) return;
  if (!spectrum.interface1.enabled) { setStatus('Enable the ZX Interface 1 in Hardware first'); return; }
  const drive = spectrum.interface1.drives[unit];
  drive.format(name);
  const filename = `${name}.mdr`;
  setMicrodriveSlot(unit, { loaded: true, name: filename, writeProtected: false, modified: false });
  persistMicrodrive(unit, drive.toMDR(), filename);
  setStatus(`Microdrive ${unit + 1}: blank cartridge inserted`);
}

export function saveMicrodrive(unit: number): void {
  if (!spectrum) return;
  const drive = spectrum.interface1.drives[unit];
  if (!drive.inserted) { setStatus(`No cartridge in microdrive ${unit + 1}`); return; }
  const base = (microdriveSlots()[unit]?.name || `mdr${unit + 1}`).replace(/\.[^.]+$/, '') || `mdr${unit + 1}`;
  downloadFile(drive.toMDR(), `${base}.mdr`);
}

/** Toggle the write-protect tab on a mounted cartridge and re-persist it. */
export function setMicrodriveWriteProtect(unit: number, wp: boolean): void {
  if (!spectrum) return;
  const drive = spectrum.interface1.drives[unit];
  if (!drive.inserted) return;
  drive.writeProtected = wp;
  setMicrodriveSlot(unit, { writeProtected: wp });
  persistMicrodrive(unit, drive.toMDR(), microdriveSlots()[unit]?.name || `mdr${unit + 1}.mdr`);
}


// ── Joystick helpers ────────────────────────────────────────────────────

export { KEMPSTON_BITS, CURSOR_KEYS, SINCLAIR1_KEYS, SINCLAIR2_KEYS, resetJoystickKeyState } from '@/peripherals/joysticks.ts';
import { joyPressForType as _joyPress } from '@/peripherals/joysticks.ts';

export function joyPressForType(dir: string, pressed: boolean, mode: string, player = 0): void {
  const cpc = asCpc(machine);
  if (cpc) {
    // The CPC joystick is fixed to the Amstrad standard: joystick 0 (P1) on
    // matrix line 9, joystick 1 (P2) on line 6. The Spectrum joystick "mode"
    // (Kempston/Sinclair/…) is irrelevant here — the player index selects it.
    const d = dir === 'fire' ? 'fire1' : dir;
    if (d === 'up' || d === 'down' || d === 'left' || d === 'right' || d === 'fire1' || d === 'fire2') {
      cpc.keyboard.setJoystick(d, pressed, player);
    }
    return;
  }
  if (!spectrum) return;
  _joyPress(spectrum, dir, pressed, mode);
}

// ── Mouse helpers ────────────────────────────────────────────────────

export type MouseMode = 'kempston' | 'amx' | null;

/** The active machine's two mice (both machines expose the same pair), or null
 *  when no machine is running. Lets the mouse helpers below stay machine-agnostic
 *  instead of repeating the asSpectrum/asCpc branch three times. */
function activeMice() {
  const s = asSpectrum(machine);
  if (s) return { kempston: s.kempstonMouse, amx: s.amxMouse };
  const c = asCpc(machine);
  if (c) return { kempston: c.kempstonMouse, amx: c.amxMouse };
  return null;
}

export function setMouseMode(mode: MouseMode): void {
  const m = activeMice();
  if (!m) return;
  m.kempston.enabled = mode === 'kempston';
  m.amx.enabled = mode === 'amx';
}

export function updateMousePosition(dx: number, dy: number, mode: MouseMode): void {
  const m = activeMice();
  if (!m) return;
  if (mode === 'kempston') m.kempston.updatePosition(dx, dy);
  else if (mode === 'amx') m.amx.queueMovement(dx, dy);
}

export function setMouseButton(button: number, pressed: boolean, mode: MouseMode): void {
  const m = activeMice();
  if (!m) return;
  if (mode === 'kempston') m.kempston.setButton(button, pressed);
  else if (mode === 'amx') m.amx.setButton(button, pressed);
}

// ── Multiface ────────────────────────────────────────────────────────

const MF_ROM_CDN = 'https://zx84files.bitsparse.com/roms/';

export async function loadMultifaceROM(s: Spectrum): Promise<boolean> {
  const variant = variantForModel(s.model);
  s.multiface.variant = variant;
  const cacheKey = `mf-rom-${variant}`;

  // Try IndexedDB cache first
  let data = await dbLoad(cacheKey);
  if (!data) {
    try {
      setStatus(`Fetching ${variantLabel(variant)} ROM...`);
      const url = MF_ROM_CDN + romFilename(variant);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = new Uint8Array(await resp.arrayBuffer());
      await dbSave(cacheKey, data);
    } catch (err) {
      console.warn('Failed to fetch Multiface ROM:', err);
      const msg = `Failed to load ${variantLabel(variant)} ROM`;
      setStatus(msg);
      setMultifaceRomFailed(msg);
      return false;
    }
  }
  s.multiface.loadROM(data);
  setStatus(`${variantLabel(variant)} ROM loaded (${data.length} bytes)`);
  setMultifaceRomFailed('');
  return true;
}

// ── VTX-5000 ─────────────────────────────────────────────────────────

const VTX5000_ROM_KEY = 'vtx5000-rom';
const VTX5000_ROM_URL = 'https://zx84files.bitsparse.com/roms/vtx5000-3-1.rom';

/**
 * Load the VTX-5000 ROM into a Spectrum instance, fetching from CDN if not
 * already cached in IndexedDB.  Mirrors the loadMultifaceROM() pattern.
 */
export async function loadVTX5000ROM(s: Spectrum): Promise<boolean> {
  let data = await dbLoad(VTX5000_ROM_KEY);
  if (!data) {
    try {
      setStatus('Fetching VTX-5000 ROM…');
      const resp = await fetch(VTX5000_ROM_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = new Uint8Array(await resp.arrayBuffer());
      await dbSave(VTX5000_ROM_KEY, data);
    } catch (err) {
      console.warn('Failed to fetch VTX-5000 ROM:', err);
      const msg = 'Failed to load VTX-5000 ROM';
      setStatus(msg);
      setVtx5000RomFailed(msg);
      return false;
    }
  }
  s.vtx5000.loadROM(data);
  setStatus(`VTX-5000 ROM loaded (${data.length} bytes)`);
  setVtx5000RomFailed('');
  return true;
}

// ── MGT +D ───────────────────────────────────────────────────────────────

const PLUSD_ROM_KEY = 'plusd-rom';
const PLUSD_ROM_URL = 'https://zx84files.bitsparse.com/roms/plusd.rom';

/**
 * Load the +D G+DOS ROM (8KB) into a Spectrum, fetching from the CDN if not
 * already cached in IndexedDB. Mirrors loadMultifaceROM / loadVTX5000ROM.
 */
export async function loadPlusDROM(s: Spectrum): Promise<boolean> {
  let data = await dbLoad(PLUSD_ROM_KEY);
  if (!data) {
    try {
      setStatus('Fetching MGT +D ROM…');
      const resp = await fetch(PLUSD_ROM_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = new Uint8Array(await resp.arrayBuffer());
      await dbSave(PLUSD_ROM_KEY, data);
    } catch (err) {
      console.warn('Failed to fetch MGT +D ROM:', err);
      const msg = 'Failed to load MGT +D ROM';
      setStatus(msg);
      setPlusDRomFailed(msg);
      return false;
    }
  }
  s.mgtPlusD.loadROM(data);
  setStatus(`MGT +D ROM loaded (${data.length} bytes)`);
  setPlusDRomFailed('');
  return true;
}

const IF1_ROM_KEY = 'if1-rom';
const IF1_ROM_URL = 'https://zx84files.bitsparse.com/roms/if1-2.rom';

/**
 * Load the ZX Interface 1 shadow ROM (8KB) into a Spectrum, fetching from the
 * CDN if not already cached in IndexedDB. Mirrors loadPlusDROM / loadVTX5000ROM.
 */
export async function loadInterface1ROM(s: Spectrum): Promise<boolean> {
  let data = await dbLoad(IF1_ROM_KEY);
  if (!data) {
    try {
      setStatus('Fetching ZX Interface 1 ROM…');
      const resp = await fetch(IF1_ROM_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = new Uint8Array(await resp.arrayBuffer());
      await dbSave(IF1_ROM_KEY, data);
    } catch (err) {
      console.warn('Failed to fetch ZX Interface 1 ROM:', err);
      const msg = 'Failed to load ZX Interface 1 ROM';
      setStatus(msg);
      setInterface1RomFailed(msg);
      return false;
    }
  }
  s.interface1.loadROM(data);
  setStatus(`ZX Interface 1 ROM loaded (${data.length} bytes)`);
  setInterface1RomFailed('');
  return true;
}

// ── ParaDOS (CPC) ────────────────────────────────────────────────────────

const PARADOS_ROM_KEY = 'cpc-parados-rom';
const PARADOS_ROM_URL = 'https://zx84files.bitsparse.com/roms/parados.rom';

/**
 * Overlay ParaDOS into upper-ROM slot 7 (replacing AMSDOS) on a disk-capable
 * CPC, fetching from CDN if not already cached in IndexedDB. Mirrors the
 * loadVTX5000ROM() pattern. The base ROM set (OS + BASIC + AMSDOS) is untouched;
 * this just swaps the ROM the firmware sees at slot 7.
 */
export async function loadParadosROM(cpc: CpcMachine): Promise<boolean> {
  let data = await dbLoad(PARADOS_ROM_KEY);
  if (!data) {
    try {
      setStatus('Fetching ParaDOS ROM…');
      const resp = await fetch(PARADOS_ROM_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = new Uint8Array(await resp.arrayBuffer());
      await dbSave(PARADOS_ROM_KEY, data);
    } catch (err) {
      console.warn('Failed to fetch ParaDOS ROM:', err);
      const msg = 'Failed to load ParaDOS ROM';
      setStatus(msg);
      setParadosRomFailed(msg);
      return false;
    }
  }
  cpc.memory.setUpperRom(7, data);
  setStatus(`ParaDOS ROM loaded (${data.length} bytes)`);
  setParadosRomFailed('');
  return true;
}

// ── Multiface Two (CPC) ──────────────────────────────────────────────────

const CPC_MF2_ROM_KEY = 'cpc-mf2-rom';
const CPC_MF2_ROM_URL = 'https://zx84files.bitsparse.com/roms/cpc-multiface2.rom';

/**
 * Load the CPC Multiface Two ROM into the machine, fetching from CDN if not
 * already cached. Mirrors loadVTX5000ROM(); shares the multifaceRomFailed signal
 * (only one machine is ever active).
 */
export async function loadCpcMultifaceROM(cpc: CpcMachine): Promise<boolean> {
  let data = await dbLoad(CPC_MF2_ROM_KEY);
  if (!data) {
    try {
      setStatus('Fetching Multiface Two ROM…');
      const resp = await fetch(CPC_MF2_ROM_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = new Uint8Array(await resp.arrayBuffer());
      await dbSave(CPC_MF2_ROM_KEY, data);
    } catch (err) {
      console.warn('Failed to fetch Multiface Two ROM:', err);
      const msg = 'Failed to load Multiface Two ROM';
      setStatus(msg);
      setMultifaceRomFailed(msg);
      return false;
    }
  }
  cpc.multiface.loadROM(data);
  setStatus(`Multiface Two ROM loaded (${data.length} bytes)`);
  setMultifaceRomFailed('');
  return true;
}

/** Enable/disable the CPC Multiface live (no machine rebuild). */
export function setCpcMultiface(on: boolean): void {
  const cpc = asCpc(machine);
  if (!cpc) return;
  cpc.multiface.enabled = on;
  if (on) {
    // Capture the current chip state into the shadow so STOP→Return works even
    // when the cartridge is switched on after the machine has already booted
    // (the PAL never saw the boot-time OUTs that configured it).
    cpc.seedMultifaceShadow();
    if (!cpc.multiface.romLoaded) {
      loadCpcMultifaceROM(cpc).catch(err => console.warn('MF2 ROM load failed:', err));
    }
  } else {
    cpc.multiface.pageOut(cpc.memory);
  }
}

export function triggerNMI(): void {
  // CPC Multiface Two — press the red STOP button.
  const cpc = asCpc(machine);
  if (cpc) {
    const mf = cpc.multiface;
    if (!mf.enabled) { setStatus('Multiface not enabled'); return; }
    if (!mf.romLoaded) { setStatus('Multiface ROM not loaded'); return; }
    mf.pressButton(cpc.memory, cpc.cpu);
    setStatus('Multiface NMI triggered');
    return;
  }

  if (!spectrum) return;
  const mf = spectrum.multiface;
  if (!mf.enabled) { setStatus('Multiface not enabled'); return; }
  if (!mf.romLoaded) { setStatus('Multiface ROM not loaded'); return; }

  mf.pressButton(spectrum.memory, spectrum.cpu, spectrum.memory.slot0Bank);
  setStatus('Multiface NMI triggered');
}

// ── Restore persisted media (tape + disks) without resetting ─────────

async function restoreMedia(): Promise<void> {
  if (!machine) return;

  // Restore tape (both machines have a deck; CDT parses as TZX)
  const tape = await restoreTape();
  if (tape) {
    try {
      const ext = tape.name.toLowerCase().split('.').pop();
      const blocks = ext === 'tzx' || ext === 'cdt'
        ? parseTZX(tape.data)
        : machine.tape.parseTAP(tape.data);
      machine.tape.blocks = blocks;
      machine.tape.position = 0;
      machine.tape.paused = true;
      batch(() => {
        setTapeLoaded(true);
        setTapeName(tape.name);
        setTapeBlocks([...blocks]);
        setTapePosition(0);
        setTapePaused(true);
        setTapePlaying(false);
      });
    } catch { /* ignore corrupt data */ }
  }

  // Restore disks (CPC and Spectrum +3 both drive the shared uPD765A)
  const diskA = await restoreDisk(0);
  if (diskA) {
    try {
      const image = parseDSK(diskA.data);
      machine.loadDisk(image, 0);
      setCurrentDiskInfo(image);
      setCurrentDiskName(diskA.name);
    } catch { /* ignore corrupt data */ }
  }

  const diskB = await restoreDisk(1);
  if (diskB) {
    try {
      const image = parseDSK(diskB.data);
      machine.loadDisk(image, 1);
      setCurrentDiskInfoB(image);
      setCurrentDiskNameB(diskB.name);
    } catch { /* ignore corrupt data */ }
  }

  // MGT +D drives C:/D: — only when the +D is fitted (its shadow ROM + WD1772
  // exist only then); enablement is restored from settings in createMachine().
  if (spectrum?.mgtPlusD.enabled) {
    for (const unit of [0, 1]) {
      const disk = await restorePlusDDisk(unit);
      if (!disk) continue;
      try {
        const image = parseMgt(disk.data, mgtExtFromName(disk.name));
        if (!image) continue;
        spectrum.loadPlusDDisk(image, unit);
        setPlusDDiskState(unit, image, disk.name);
      } catch { /* ignore corrupt data */ }
    }
  }

  // ZX Interface 1 microdrives (drives 1-8) — only when the IF1 is fitted.
  if (spectrum?.interface1.enabled) {
    for (let unit = 0; unit < 8; unit++) {
      const cart = await restoreMicrodrive(unit);
      if (!cart) continue;
      try {
        const drive = spectrum.interface1.drives[unit];
        drive.loadMDR(cart.data);
        setMicrodriveSlot(unit, { loaded: true, name: cart.name, writeProtected: drive.writeProtected, modified: false });
      } catch { /* ignore corrupt data */ }
    }
  }
}

// ── Init ────────────────────────────────────────────────────────────────

export async function init(): Promise<void> {
  const model = currentModel();

  const romModel = effectiveROMModel(model);
  let entry = await restoreROM(romModel);
  if (!entry) entry = await fetchDefaultROM(romModel);

  if (entry) {
    romData = entry.data;
    setRomStatus('');
    await createMachine();

    // Always re-mount persisted media. The HMR/SZX snapshot restored by
    // createMachine() captures RAM/CPU/AY state but NOT the mounted disk and
    // tape *images* — those are persisted separately (one blob per drive/tape
    // in IndexedDB). restoreMedia() loads the FDC image and tape blocks plus
    // the UI state without touching restored RAM, so a hard reload keeps both
    // the machine state and the inserted media.
    await restoreMedia();
  }
}

// ── Transcribe ──────────────────────────────────────────────────────────

export function toggleTranscribeMode(mode: 'text'): void {
  if (transcribeMode() === mode) {
    setTranscribeMode('off');
  } else {
    setTranscribeMode(mode);
  }
}

// ── Renderer switching ──────────────────────────────────────────────────

export function switchRenderer(mode: 'webgl' | 'canvas'): void {
  settings.setRenderer(mode);
  settings.persistSetting('renderer', mode);
}



// ── Audio init ──────────────────────────────────────────────────────────

export function initAudio(): void {
  if (spectrum && !spectrum['audio'].running) {
    spectrum['audio'].init();
  }
}

// ── HMR state preservation ──────────────────────────────────────────────

const HMR_STATE_KEY = 'zx84-hmr-state';

/** Base64-encode bytes in chunks — String.fromCharCode(...all) overflows the
 *  call stack for the ~128KB uncompressed snapshot, so feed it 32KB at a time. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Snapshot machine state to localStorage so a page refresh resumes where it
 * left off. MUST be fully synchronous: this runs from a `beforeunload` handler
 * that can't await, so it uses the uncompressed (no CompressionStream) SZX
 * writer — an async deflate here would never finish before the page unloads,
 * leaving a stale snapshot that resumes the game into a corrupted state.
 */
export function saveHMRState(): void {
  if (!spectrum || !romData) return;

  try {
    // Stop emulation so flushBanks() sees a settled frame (no torn RAM).
    if (!emulationPaused()) spectrum.stop();

    const ayRegs = spectrum.ay.getRegisters();
    const szxData = saveSZXSync(
      spectrum.cpu,
      spectrum.memory,
      spectrum.ula.borderColor,
      currentModel() as SpectrumModel,
      spectrum.contention.frameStartTStates,
      ayRegs,
      spectrum.ay.selectedReg
    );

    const state = {
      snapshot: bytesToBase64(szxData),
      model: currentModel(),
      timestamp: Date.now(),
    };

    localStorage.setItem(HMR_STATE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Failed to save HMR state:', err);
  }
}

export async function restoreHMRState(): Promise<boolean> {
  try {
    const raw = localStorage.getItem(HMR_STATE_KEY);
    if (!raw) return false;

    const state = JSON.parse(raw);
    const age = Date.now() - state.timestamp;

    // Only restore if less than 60 seconds old (avoid restoring stale state)
    if (age > 60000) {
      localStorage.removeItem(HMR_STATE_KEY);
      return false;
    }

    // Decode snapshot
    const b64 = state.snapshot;
    const binary = atob(b64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      data[i] = binary.charCodeAt(i);
    }

    // Wait for spectrum to be ready
    if (!spectrum || !romData) return false;

    // Load SZX snapshot
    spectrum.stop();
    spectrum.reset();
    const result = await loadSZX(data, spectrum.cpu, spectrum.memory);

    // Apply paging state for 128K. Shared with the file-load path so the +2A/+3
    // ROM-bit handling can't drift (a stale copy here paged in the wrong ROM and
    // froze ROM-dependent interrupt effects after a refresh).
    applySZXPaging(spectrum.memory, spectrum.variant.hasSpecialPaging, result);

    spectrum.ula.borderColor = result.borderColor;
    // Restore AY state if present
    if (result.ayRegs) {
      spectrum.ay.setRegisters(result.ayRegs);
      if (result.ayCurrentReg !== undefined) {
        spectrum.ay.selectedReg = result.ayCurrentReg;
      }
    }

    spectrum.start();

    // Clean up
    localStorage.removeItem(HMR_STATE_KEY);

    setStatus('HMR: State restored');
    return true;
  } catch (err) {
    console.warn('Failed to restore HMR state:', err);
    localStorage.removeItem(HMR_STATE_KEY);
    return false;
  }
}

// ── HMR cleanup ─────────────────────────────────────────────────────────

export function destroy(): void {
  floppySound?.destroy();
  floppySound = null;
  if (machine) {
    machine.destroy();
    machine = null;
    spectrum = null;
  }
}
