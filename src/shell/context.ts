/**
 * Shell context — the shared, mutable machine handle and the low-level plumbing
 * the four shell action modules (lifecycle / media / settings / rom) all reach.
 *
 * `emulator.ts` was a single god-module holding this state as top-level `let`
 * bindings. Splitting it into src/shell/* means several modules now reassign the
 * same handles (rom.ts sets `romData`, lifecycle.ts sets `machine`, …), which
 * ESM live bindings forbid across module boundaries — so the state lives here,
 * behind setters, and every shell module imports it. This module imports nothing
 * from the other shell modules, so it is the dependency root of the shell.
 */

import { type Machine, asSpectrum } from '@/machines/machine.ts';
import { entryForModel } from '@/machines/registry.ts';
import type { MachineModel } from '@/models.ts';
import { WebGLRenderer } from '@/display/webgl-renderer.ts';
import { CanvasRenderer } from '@/display/canvas-renderer.ts';
import type { FloppySound } from '@/media/floppy/floppy-sound.ts';
import * as settings from '@/store/settings.ts';
import { setStatusText, setRomStatusText, currentModel } from '@/state/machine-state.ts';
import { ROMManager } from '@/managers/rom-manager.ts';
import { DebugManager } from '@/managers/debug-manager.ts';

// ── Manager instances (shared machinery) ─────────────────────────────────
export const romManager = new ROMManager();
export const debugManager = new DebugManager();

// ── Mutable machine handles ──────────────────────────────────────────────

/** The active machine. Canonical handle for lifecycle/driver. */
export let machine: Machine | null = null;
/** Narrowed view of `machine` when it is a Spectrum, else null. Spectrum-only
 *  code paths (tape, Multiface, VTX, ULA, snapshots) use this and no-op on CPC.
 *  Typed via the SPI narrowing so the shell root doesn't import the machine folder. */
export let spectrum: ReturnType<typeof asSpectrum> = null;
export let romData: Uint8Array | null = null;
export let floppySound: FloppySound | null = null;
export let canvasEl: HTMLCanvasElement | null = null;

/** Install the active machine (and derive the Spectrum narrowing). */
export function setMachine(m: Machine | null): void {
  machine = m;
  spectrum = asSpectrum(m);
}
export function setRomData(data: Uint8Array | null): void { romData = data; }
export function setFloppySound(fs: FloppySound | null): void { floppySound = fs; }
export function setCanvasEl(el: HTMLCanvasElement | null): void { canvasEl = el; }

// ── Status line ──────────────────────────────────────────────────────────

export function setStatus(msg: string): void { setStatusText(msg); }
export function setRomStatus(msg: string): void { setRomStatusText(msg); }

// ── ROM model aliasing ───────────────────────────────────────────────────

/**
 * Returns the ROM model key to use when loading ROMs for a given machine model.
 * The +3 always uses the +2A's ROM set (v4.1) — the only difference between
 * the two is the FDC; upload a v4.0 image via the ROM pane if one is needed.
 */
export function effectiveROMModel(model: MachineModel): MachineModel {
  return model === '+3' ? '+2A' : model;
}

// ── Display ──────────────────────────────────────────────────────────────

export function createDisplay(el: HTMLCanvasElement, w: number, h: number) {
  // Pixel aspect is machine metadata (the CPC's buffer is 2× oversampled
  // horizontally and displays at half width to restore ~4:3).
  const model = currentModel();
  const pixelAspectX = entryForModel(model).descriptor(model).screen.pixelAspectX;
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
