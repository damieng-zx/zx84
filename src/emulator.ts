/**
 * Machine lifecycle: spectrum instance, ROM management, model switching.
 */

import { batch } from 'solid-js';
import { Spectrum } from '@/spectrum.ts';
import { CpcMachine } from '@/cpc/cpc-machine.ts';
import { type Machine, asSpectrum, asCpc } from '@/machine.ts';
import {
  type SpectrumModel, type MachineModel, type CpcModel,
  is128kClass, isPlus2AClass, isCpcModel,
} from '@/models.ts';
import { CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT } from '@/cpc/constants.ts';
import { WebGLRenderer } from '@/display/webgl-renderer.ts';
import { CanvasRenderer } from '@/display/canvas-renderer.ts';
import { FloppySound } from '@/plus3/floppy-sound.ts';
import { PALETTES, SCREEN_WIDTH, SCREEN_HEIGHT } from '@/cores/ula.ts';
import { saveSZX } from '@/snapshot/szx.ts';
import { saveZ80 } from '@/snapshot/z80format.ts';
import { parseTZX } from '@/tape/tzx.ts';
import { parseDSK, serializeDSK, type DskImage } from '@/plus3/dsk.ts';
import { loadSZX } from '@/snapshot/szx.ts';
import { clearLastFile, restoreTape, restoreDisk, dbSave, dbLoad } from '@/store/persistence.ts';
import * as settings from '@/store/settings.ts';
import { variantForModel, variantLabel, romFilename } from '@/peripherals/multiface.ts';
import { onFrame, updateRegsOnce, resetSpeedTracking, forceSpeedUpdate } from '@/frame-bridge.ts';
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
  setMultifaceRomFailed,
  setVtx5000RomFailed,
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
export { multifaceRomFailed, vtx5000RomFailed };

// Re-export tape state
export { tapeLoaded, tapeBlocks, tapePosition, tapePaused, tapePlaying, tapeName };
export { setTapeLoaded, setTapeName, setTapeBlocks, setTapePosition, setTapePaused, setTapePlaying };

// Re-export disk state
export { currentDiskInfo, currentDiskName, currentDiskInfoB, currentDiskNameB, driveAStatus, driveBStatus, diskInfoHtml, driveHtml };
export { setCurrentDiskInfo, setCurrentDiskName, setCurrentDiskInfoB, setCurrentDiskNameB, setDriveAStatus, setDriveBStatus, setDiskInfoHtml, setDriveHtml };

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
    s.tapeInstantLoad = settings.tapeInstantRom();
    s.tapeTurbo = settings.tapeTurboLoad();
    s.tapeSoundEnabled = settings.tapeSoundEnabled();
    s.loaderDetector.accelerateLoader = settings.tapeEdgeLoading();
    s.scanlineAccuracy = settings.scanlineAccuracy();
  } else {
    // CPC: AY-only, no beeper mixer or tape. Volume only.
    (machine as CpcMachine).audio.setVolume(settings.volume() / 100);
  }
}

export async function createMachine(): Promise<boolean> {
  if (!canvasEl) return false;

  // Preserve tape state across machine rebuild (Spectrum only)
  const prevSpec = asSpectrum(machine);
  const savedTapeBlocks = prevSpec ? [...prevSpec.tape.blocks] : null;
  const savedTapePos = prevSpec ? prevSpec.tape.position : 0;
  const savedTapePaused = prevSpec ? prevSpec.tape.paused : true;
  const savedTapeName = tapeName();

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
  }

  let hmrRestored = false;
  if (romData) {
    machine.loadROM(romData);
    machine.reset();

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

  // Restore tape if one was loaded (Spectrum only)
  if (spectrum && savedTapeBlocks && savedTapeBlocks.length > 0) {
    spectrum.tape.blocks = savedTapeBlocks;
    spectrum.tape.position = savedTapePos;
    spectrum.tape.paused = savedTapePaused;
    batch(() => {
      setTapeLoaded(true);
      setTapeName(savedTapeName);
      setTapeBlocks([...savedTapeBlocks]);
      setTapePosition(savedTapePos);
      setTapePaused(savedTapePaused);
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

export function togglePause(): void {
  if (!machine) return;
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

/** Try to switch to a 128K-class ROM, returning false if none available. */
async function ensure128kROM(): Promise<boolean> {
  const models: SpectrumModel[] = ['128k', '+2', '+2A', '+3'];
  for (const model of models) {
    const entry = await restoreROM(model);
    if (entry) {
      setCurrentModel(model);
      romData = entry.data;
      setRomStatus('');
      await createMachine();
      return true;
    }
  }
  return false;
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
  };
}


// ── Tape/Disk loading (via MediaManager) ───────────────────────────────

export function applyTape(data: Uint8Array, filename: string): void {
  if (!spectrum) { setStatus('Load a ROM first'); return; }

  mediaManager.applyTape(spectrum, data, filename, {
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

export async function loadFile(data: Uint8Array, filename: string, unit?: number): Promise<void> {
  // CPC is disk-only: route .dsk images straight into the shared uPD765A.
  const cpc = asCpc(machine);
  if (cpc) {
    if (!/\.dsk$/i.test(filename)) { setStatus('CPC accepts .dsk disk images only'); return; }
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
    data = saveZ80(spectrum.cpu, spectrum.memory, spectrum.ula.borderColor, spectrum.variant.hasBanking);
  }

  const filename = `zx84-${model.replace('+', 'plus')}.${format}`;

  downloadFile(data, filename);

  if (!wasPaused) spectrum.start();
  setStatus(`Saved ${filename}`);
}

export function saveScreenshot(format: 'png' | 'scr'): void {
  if (!spectrum) { setStatus('No machine running'); return; }

  if (format === 'scr') {
    // .scr = raw 6912 bytes from 0x4000 (6144 pixels + 768 attrs)
    const screenData = spectrum.memory.getRamBank(5).slice(0, 6912);
    downloadFile(screenData, 'screen.scr');
    setStatus('Saved screen.scr');
  } else {
    // PNG export via canvas
    if (!spectrum.display) { setStatus('No display available'); return; }
    const canvas = spectrum.display['canvas'] as HTMLCanvasElement;
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
  if (!spectrum) return;
  spectrum.tape.rewind();
  setTapePosition(0);
}

export function tapePrev(): void {
  if (!spectrum) return;
  if (spectrum.tape.position > 0) spectrum.tape.position--;
  setTapePosition(spectrum.tape.position);
}

export function tapeTogglePlay(): void {
  if (!spectrum) return;
  if (spectrum.tape.playing) {
    // User-initiated stop — block the LoaderDetector from auto-restarting
    // on post-load keyboard polling. Cleared on the next manual play.
    spectrum.loaderDetector.userOverride = true;
    spectrum.tape.stopPlayback();
    setTapePlaying(false);
  } else {
    spectrum.loaderDetector.userOverride = false;
    spectrum.tape.paused = false;
    spectrum.tape.startPlayback();
    setTapePaused(false);
    setTapePlaying(true);
  }
}

export function tapeTogglePause(): void {
  if (!spectrum) return;
  spectrum.tape.paused = !spectrum.tape.paused;
  // Pausing is a user action — prevent the LoaderDetector from auto-
  // resuming the tape via its 'start' event on post-load polling. Cleared
  // when the user unpauses.
  spectrum.loaderDetector.userOverride = spectrum.tape.paused;
  setTapePaused(spectrum.tape.paused);
}

export function tapeNext(): void {
  if (!spectrum) return;
  if (spectrum.tape.position < spectrum.tape.blocks.length) spectrum.tape.position++;
  setTapePosition(spectrum.tape.position);
}

export function tapeSetPosition(pos: number): void {
  if (!spectrum) return;
  spectrum.tape.position = pos;
  setTapePosition(pos);
}

export function toggleAutoRewind(): void {
  settings.setTapeAutoRewind(!settings.tapeAutoRewind());
  settings.persistSetting('tape-auto-rewind', settings.tapeAutoRewind() ? 'on' : 'off');
}

export function ejectTape(): void {
  if (!spectrum) return;
  mediaManager.ejectTape(spectrum, () => {
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
    } else {
      setCurrentDiskInfoB(null);
      setCurrentDiskNameB('');
    }
  };
  if (spectrum) {
    mediaManager.ejectDisk(spectrum, unit, onEjected, setStatus);
  } else {
    machine.fdc.ejectDisk(unit);
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

export function saveDisk(unit: number): void {
  if (!machine) return;
  const image = machine.fdc.getDiskImage(unit);
  if (!image) { setStatus(`No disk in drive ${unit === 0 ? 'A' : 'B'}:`); return; }
  const name = unit === 0 ? currentDiskName() : currentDiskNameB();
  const filename = name.replace(/\.[^.]+$/, '') + '.dsk';
  downloadFile(serializeDSK(image), filename);
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

export function setMouseMode(mode: MouseMode): void {
  if (!spectrum) return;
  spectrum.kempstonMouse.enabled = mode === 'kempston';
  spectrum.amxMouse.enabled = mode === 'amx';
}

export function updateMousePosition(dx: number, dy: number, mode: MouseMode): void {
  if (!spectrum) return;
  if (mode === 'kempston') {
    spectrum.kempstonMouse.updatePosition(dx, dy);
  } else if (mode === 'amx') {
    spectrum.amxMouse.queueMovement(dx, dy);
  }
}

export function setMouseButton(button: number, pressed: boolean, mode: MouseMode): void {
  if (!spectrum) return;
  if (mode === 'kempston') {
    spectrum.kempstonMouse.setButton(button, pressed);
  } else if (mode === 'amx') {
    spectrum.amxMouse.setButton(button, pressed);
  }
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

export function triggerNMI(): void {
  if (!spectrum) return;
  const mf = spectrum.multiface;
  if (!mf.enabled) { setStatus('Multiface not enabled'); return; }
  if (!mf.romLoaded) { setStatus('Multiface ROM not loaded'); return; }

  mf.pressButton(spectrum.memory, spectrum.cpu, spectrum.memory.slot0Bank);
  setStatus('Multiface NMI triggered');
}

// ── Restore persisted media (tape + disks) without resetting ─────────

async function restoreMedia(): Promise<void> {
  if (!spectrum) return;

  // Restore tape
  const tape = await restoreTape();
  if (tape) {
    try {
      const ext = tape.name.toLowerCase().split('.').pop();
      const blocks = ext === 'tzx' ? parseTZX(tape.data) : spectrum.tape.parseTAP(tape.data);
      spectrum.tape.blocks = blocks;
      spectrum.tape.position = 0;
      spectrum.tape.paused = true;
      batch(() => {
        setTapeLoaded(true);
        setTapeName(tape.name);
        setTapeBlocks([...blocks]);
        setTapePosition(0);
        setTapePaused(true);
        setTapePlaying(false);
      });
      setStatus(`Tape restored: ${tape.name}`);
    } catch { /* ignore corrupt data */ }
  }

  // Restore disk A
  const diskA = await restoreDisk(0);
  if (diskA) {
    try {
      const image = parseDSK(diskA.data);
      spectrum.loadDisk(image, 0);
      setCurrentDiskInfo(image);
      setCurrentDiskName(diskA.name);
    } catch { /* ignore corrupt data */ }
  }

  // Restore disk B
  const diskB = await restoreDisk(1);
  if (diskB) {
    try {
      const image = parseDSK(diskB.data);
      spectrum.loadDisk(image, 1);
      setCurrentDiskInfoB(image);
      setCurrentDiskNameB(diskB.name);
    } catch { /* ignore corrupt data */ }
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

export async function saveHMRState(): Promise<void> {
  if (!spectrum || !romData) return;

  try {
    // Stop emulation temporarily
    const wasPaused = emulationPaused();
    if (!wasPaused) spectrum.stop();

    // Save snapshot data as SZX
    const ayRegs = spectrum.ay.getRegisters();
    const szxData = await saveSZX(
      spectrum.cpu,
      spectrum.memory,
      spectrum.ula.borderColor,
      currentModel() as SpectrumModel,
      spectrum.contention.frameStartTStates,
      ayRegs,
      spectrum.ay.selectedReg
    );

    // Convert to base64 for localStorage
    const b64 = btoa(String.fromCharCode(...szxData));

    // Save state bundle
    const state = {
      snapshot: b64,
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

    // Apply paging state for 128K
    if (result.is128K) {
      spectrum.memory.port7FFD = result.port7FFD;
      spectrum.memory.currentBank = result.port7FFD & 0x07;
      spectrum.memory.currentROM = (result.port7FFD >> 4) & 1;
      spectrum.memory.pagingLocked = (result.port7FFD & 0x20) !== 0;
      if (spectrum.variant.hasSpecialPaging) {
        spectrum.memory.port1FFD = result.port1FFD;
        spectrum.memory.specialPaging = (result.port1FFD & 1) !== 0;
      }
      spectrum.memory.applyBanking();
    }

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
