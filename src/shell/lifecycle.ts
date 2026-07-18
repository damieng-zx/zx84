/**
 * Shell lifecycle: machine construction and model switching, the MachineHost the
 * shell hands each machine, pause / turbo / focus-pause, the debugger step and
 * trace wrappers, the boot-loader auto-trap, HMR state save/restore, and init.
 */

import type { MachineHost } from '@/machines/machine.ts';
import { entryForModel } from '@/machines/registry.ts';
import {
  type SpectrumModel, type MachineModel,
  romPageSlotCount,
} from '@/models.ts';
import { BANK_SIZE } from '@/utils/bank-size.ts';
import { FloppySound } from '@/media/floppy/floppy-sound.ts';
import { saveSZXSync, loadSZX, applySZXPaging } from '@/machines/spectrum/snapshots/szx.ts';
import type { RomPage } from '@/managers/rom-manager.ts';
import { type TraceMode } from '@/managers/debug-manager.ts';
import * as settings from '@/store/settings.ts';
import { clearLastFile } from '@/store/persistence.ts';
import { decideFocusPause } from '@/focus-pause.ts';
import {
  currentModel, setCurrentModel, saveModel, emulationPaused, setEmulationPaused, setTurboMode,
} from '@/state/machine-state.ts';
import {
  setDisasmText, setSysvarHtml, setBasicHtml, setBasicVarsHtml, setTracing,
} from '@/state/debug-state.ts';
import { transcribeMode, setTranscribeMode } from '@/state/activity-state.ts';
import {
  setCurrentDiskInfo, setCurrentDiskName, setCurrentDiskInfoB, setCurrentDiskNameB,
} from '@/state/disk-state.ts';
import {
  onFrame, updateRegsOnce, resetSpeedTracking, resetLedActivity, forceSpeedUpdate,
} from '@/frame-bridge.ts';
import {
  machine, spectrum, romData, floppySound, canvasEl,
  romManager, debugManager,
  setMachine, setRomData, setFloppySound, setCanvasEl,
  setStatus, setRomStatus, effectiveROMModel, createDisplay,
} from '@/shell/context.ts';
import {
  persistROM, restoreROM, fetchDefaultROM, ensure128kROM, updateRomPaneInfo, fulfillAuxRoms,
} from '@/shell/rom.ts';
import {
  stashOutgoingTape, restoreTapeForMachine, restoreMedia,
  applyEinsteinXtalDosDisk, resetEinsteinPhantom,
} from '@/shell/media.ts';
import { applyDisplaySettings, buildSettingsView } from '@/shell/settings.ts';

// Re-export TraceMode + font helpers for compatibility (font capture lives in
// frame-bridge; the shell surfaces it to the UI).
export type { TraceMode };
export { fontDataHash, updateFontPreview, loadFontStore, saveFontStore, capturedFontData } from '@/frame-bridge.ts';
export type { FontEntry } from '@/frame-bridge.ts';

// ── MachineHost ────────────────────────────────────────────────────────────

/**
 * The operator's panel handed to each machine via attachHost(): status line,
 * model-upgrade requests (128K snapshot on a 48K), and the EPROM box backing
 * the machine's RomService. All shell-owned state stays behind this seam.
 */
function buildMachineHost(): MachineHost {
  return {
    setStatus,
    async requestModel(model, _reason) {
      if (model === '128k') {
        // Any 128K-class machine with a restorable ROM satisfies a 128K
        // snapshot — same fallback chain ensure128kROM always used.
        return await ensure128kROM();
      }
      await switchModel(model);
      return true;
    },
    persistMedia(_kind, _data, _name) {
      // Persistence currently stays in shell reflection (reflectSpectrumMount
      // and the pane helpers) so keys/behaviour are byte-identical.
    },
    roms: {
      persistFull: (data, label) => persistROM(effectiveROMModel(currentModel()), data, label),
      clearFull: () => romManager.clearROM(effectiveROMModel(currentModel())),
      persistPage: (page, data, label) => romManager.persistROMPage(effectiveROMModel(currentModel()), page as RomPage, data, label),
      clearPage: (page) => romManager.clearROMPage(effectiveROMModel(currentModel()), page as RomPage),
      cached: () => {
        const e = romManager.getCached(effectiveROMModel(currentModel()));
        return e ? { label: e.label, size: e.data.length, isCustom: e.isCustom } : null;
      },
      cachedPage: (page) => {
        const e = romManager.getCachedPage(effectiveROMModel(currentModel()), page as RomPage);
        return e ? { label: e.label, size: e.data.length } : null;
      },
      rebuild: () => switchModel(currentModel()),
    },
  };
}

// ── Machine construction ─────────────────────────────────────────────────

export async function createMachine(): Promise<boolean> {
  if (!canvasEl) return false;

  // Stash the outgoing machine's tape under its own platform kind so tapes for
  // different systems stay independent (see stashOutgoingTape).
  if (machine) stashOutgoingTape(machine);
  if (machine) machine.destroy();

  const model = currentModel();
  const entry = entryForModel(model);
  const { width: w, height: h } = entry.descriptor(model).screen;
  const display = canvasEl ? createDisplay(canvasEl, w, h) : null;
  const built = entry.create(model, display);
  setMachine(built);
  built.attachHost?.(buildMachineHost());
  resetEinsteinPhantom();   // fresh FDC on the new machine
  built.onStatus = (msg: string) => setStatus(msg);
  built.onFrame = onFrame;
  applyDisplaySettings();
  resetSpeedTracking();
  resetLedActivity();   // drop any LED hold state carried over from a prior machine

  const view = buildSettingsView();

  // Fit the machine's own peripherals (VTX-5000, Multiface, +D, IF1, Beta on the
  // Spectrum; Multiface Two on the CPC) and load their ROMs BEFORE loadROM/reset
  // so they are paged when the machine boots. Which peripherals, which ROMs, and
  // the enable/mutual-exclusion rules all live in the machine's prepare() hook;
  // the shell only fulfils the returned ROM requests.
  await fulfillAuxRoms(built.prepare?.(view) ?? []);

  let hmrRestored = false;
  if (romData) {
    built.services.roms.installSystemRom(romData);
    built.reset();

    // Post-reset ROM overlays (CPC ParaDOS in upper ROM 7) — applied after the
    // firmware ROM set is in place, on machine build only.
    await fulfillAuxRoms(built.bootRoms?.(view) ?? []);

    // HMR state restore is Spectrum-only (snapshot formats); CPC starts fresh.
    if (spectrum) hmrRestored = await restoreHMRState();
    if (!hmrRestored) {
      built.start();
    }
  }

  // Fresh drive-pane signals; floppy sound synth only for machines with a
  // built-in controller (write-protects/force-ready are applied by each
  // machine's prepare() from the same settings keys).
  setCurrentDiskInfo(null);
  setCurrentDiskName('');
  setCurrentDiskInfoB(null);
  setCurrentDiskNameB('');
  if (built.descriptor.ui.builtinDisk) {
    if (!floppySound) setFloppySound(new FloppySound());
    floppySound!.reset();
  } else {
    floppySound?.destroy();
    setFloppySound(null);
  }

  // Restore the tape stashed for the NEW machine's platform kind (if any).
  restoreTapeForMachine(built);

  // Einstein: mount the phantom BASIC boot disk if the option is on and drive 0
  // is empty (fire-and-forget — it only matters once the user presses Ctrl-BREAK).
  applyEinsteinXtalDosDisk();

  // Refresh the ROM pane (system ROM label/size; a fresh machine has no cart).
  updateRomPaneInfo();

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

// ── Pause / focus-pause ────────────────────────────────────────────────────

// True while emulation is paused solely because the tab/window lost focus, so
// syncFocusPause() knows it may auto-resume. Any manual pause/unpause clears it.
let autoPausedByBlur = false;

/**
 * Pause when the tab is hidden or the window loses focus; resume on return.
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

// ── Stepping ────────────────────────────────────────────────────────────

export function stepInto(): void {
  if (!machine) return;
  if (!emulationPaused()) { machine.stop(); setEmulationPaused(true); }
  debugManager.stepInto(machine, updateRegsOnce);
}

export function stepOver(): void {
  if (!machine) return;
  if (!emulationPaused()) { machine.stop(); setEmulationPaused(true); }
  debugManager.stepOver(machine, updateRegsOnce);
}

export function stepOut(): void {
  if (!machine) return;
  if (!emulationPaused()) { machine.stop(); setEmulationPaused(true); }
  debugManager.stepOut(machine, updateRegsOnce);
}

export function stepFrame(): void {
  if (!machine) return;
  if (!emulationPaused()) { machine.stop(); setEmulationPaused(true); }
  debugManager.stepFrame(machine, updateRegsOnce);
}

// ── Reset / boot ──────────────────────────────────────────────────────────

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
  if (model === '+2A' || model === '+3') return 0x1875;   // +2A/+3 menu wait loop
  if (model === '128k' || model === '+2') return 0x0E65;  // 128K/+2 menu wait loop
  return 0x15DE;                                           // 48K editor WAIT-KEY
}

/**
 * Reset the machine and arm a one-shot trap to kick off its loader once the ROM
 * reaches its menu/editor key-wait loop. Used by the software library's
 * one-click play. The media must already be mounted.
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

// ── Debug wrappers ─────────────────────────────────────────────────────────

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

export async function switchModel(model: MachineModel): Promise<void> {
  setCurrentModel(model);
  saveModel(model);

  // The +D/Beta are model-independent peripherals: preserve any mounted disks
  // across the rebuild so a model switch doesn't leave the new controller empty.
  const disksSvc = machine?.services.disks;
  const carriedPlusD = disksSvc?.drives.some(d => d.id === 'plusd:0')
    ? [disksSvc.image?.('plusd:0') ?? null, disksSvc.image?.('plusd:1') ?? null]
    : null;
  const carriedBeta = disksSvc?.drives.some(d => d.id === 'beta:0')
    ? [disksSvc.image?.('beta:0') ?? null, disksSvc.image?.('beta:1') ?? null]
    : null;

  const romModel = effectiveROMModel(model);
  let entry = await restoreROM(romModel);
  if (!entry) entry = await fetchDefaultROM(romModel);

  if (entry) {
    let data = entry.data;
    const pageCount = romPageSlotCount(romModel);
    if (pageCount > 0) {
      // Splice any per-page overrides onto the base image, without mutating
      // the cached default (2 pages for 128K/+2, 4 for +2A/+3).
      const pages = await Promise.all(
        Array.from({ length: pageCount }, (_, page) => romManager.restoreROMPage(romModel, page as RomPage))
      );
      if (pages.some(p => p !== null)) {
        data = new Uint8Array(entry.data);
        pages.forEach((p, page) => {
          if (p) data.set(p.data.subarray(0, BANK_SIZE), page * BANK_SIZE);
        });
      }
    }
    setRomData(data);
    setRomStatus('');
  } else {
    setRomData(null);
    setRomStatus('');
  }

  await createMachine();

  const newDisks = machine?.services.disks;
  if (carriedPlusD && newDisks?.drives.some(d => d.id === 'plusd:0')) {
    if (carriedPlusD[0]) newDisks.insert('plusd:0', carriedPlusD[0], '');
    if (carriedPlusD[1]) newDisks.insert('plusd:1', carriedPlusD[1], '');
  }
  if (carriedBeta && newDisks?.drives.some(d => d.id === 'beta:0')) {
    if (carriedBeta[0]) newDisks.insert('beta:0', carriedBeta[0], '');
    if (carriedBeta[1]) newDisks.insert('beta:1', carriedBeta[1], '');
  }
}

// ── Canvas / display ──────────────────────────────────────────────────────

export function setCanvas(el: HTMLCanvasElement): void {
  setCanvasEl(el);
  if (machine) {
    // The machine reports its live frame-buffer geometry (the Spectrum's
    // shrinks with the border-size setting).
    machine.display = createDisplay(el, machine.frameWidth, machine.frameHeight);
    applyDisplaySettings();
  }
}

// ── Init ────────────────────────────────────────────────────────────────

export async function init(): Promise<void> {
  const model = currentModel();

  const romModel = effectiveROMModel(model);
  let entry = await restoreROM(romModel);
  if (!entry) entry = await fetchDefaultROM(romModel);

  if (entry) {
    setRomData(entry.data);
    setRomStatus('');
    await createMachine();

    // Always re-mount persisted media. The HMR/SZX snapshot restored by
    // createMachine() captures RAM/CPU/AY state but NOT the mounted disk and
    // tape *images* — those are persisted separately.
    await restoreMedia();
  }
}

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
 * left off. MUST be fully synchronous (runs from a `beforeunload` handler).
 */
export function saveHMRState(): void {
  if (!spectrum || !romData) return;

  try {
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

    const b64 = state.snapshot;
    const binary = atob(b64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      data[i] = binary.charCodeAt(i);
    }

    if (!spectrum || !romData) return false;

    spectrum.stop();
    spectrum.reset();
    const result = await loadSZX(data, spectrum.cpu, spectrum.memory);

    // Apply paging state for 128K. Shared with the file-load path so the +2A/+3
    // ROM-bit handling can't drift.
    applySZXPaging(spectrum.memory, spectrum.variant.hasSpecialPaging, result);

    spectrum.ula.borderColor = result.borderColor;
    if (result.ayRegs) {
      spectrum.ay.setRegisters(result.ayRegs);
      if (result.ayCurrentReg !== undefined) {
        spectrum.ay.selectedReg = result.ayCurrentReg;
      }
    }

    spectrum.start();

    localStorage.removeItem(HMR_STATE_KEY);

    setStatus('HMR: State restored');
    return true;
  } catch (err) {
    console.warn('Failed to restore HMR state:', err);
    localStorage.removeItem(HMR_STATE_KEY);
    return false;
  }
}

// ── Teardown ────────────────────────────────────────────────────────────

export function destroy(): void {
  floppySound?.destroy();
  setFloppySound(null);
  if (machine) {
    machine.destroy();
    setMachine(null);
  }
}
