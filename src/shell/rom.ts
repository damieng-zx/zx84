/**
 * Shell ROM orchestration: system-ROM fetch/cache/persist, the ROM-pane info
 * signals, per-model system-ROM overrides, and the generic peripheral-ROM
 * fulfiller (each machine declares WHICH ROMs via AuxRomRequest; the shell owns
 * the fetch/IndexedDB-cache/status/failure-signal mechanics).
 *
 * The fetch/cache/persist machinery is the shared ROMManager; this module is the
 * glue between it and the shell's state signals + the active machine.
 */

import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import {
  multifaceAuxRom, vtx5000AuxRom, plusDAuxRom, if1AuxRom, betaAuxRom,
} from '@/machines/spectrum/aux-roms.ts';
import { asMsx, type AuxRomRequest } from '@/machines/machine.ts';
import {
  type SpectrumModel, type MachineModel,
  is128kClass, isPlus2AClass, isCpcModel, romPageSlotCount,
} from '@/models.ts';
import { BANK_SIZE } from '@/utils/bank-size.ts';
import { defaultRomPageLabel, type RomPage } from '@/managers/rom-manager.ts';
import { dbSave, dbLoad } from '@/store/persistence.ts';
import {
  currentModel as currentModelValue,
  setCurrentModel, saveModel,
  setSystemRomLabel, setSystemRomSize, setSystemRomIsCustom,
  setSystemRomPageLabels, setSystemRomPageSizes, setSystemRomPageOverridden,
  setCartridgeName,
  setMultifaceRomFailed, setVtx5000RomFailed, setParadosRomFailed,
  setPlusDRomFailed, setInterface1RomFailed, setBetaDiskRomFailed,
} from '@/state/machine-state.ts';
import {
  romManager, machine, spectrum, romData, setRomData,
  setStatus, setRomStatus, effectiveROMModel,
} from '@/shell/context.ts';
import { createMachine, switchModel } from '@/shell/lifecycle.ts';

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

// ── System ROM + MSX cartridge (ROM pane) ─────────────────────────────────

/** Refresh the ROM-pane signals from the current machine's system ROM and any
 *  mounted cartridge. Called after every (re)build of the machine. */
export function updateRomPaneInfo(): void {
  const model = effectiveROMModel(currentModelValue());
  const entry = romManager.getCached(model);
  setSystemRomLabel(entry?.label ?? '');
  setSystemRomSize(romData?.length ?? 0);
  setSystemRomIsCustom(entry?.isCustom ?? false);

  const pageCount = romPageSlotCount(model);
  const labels: string[] = [];
  const sizes: number[] = [];
  const overridden: boolean[] = [];
  for (let page = 0; page < pageCount; page++) {
    const p = romManager.getCachedPage(model, page as RomPage);
    labels.push(p?.label ?? defaultRomPageLabel(model, page as RomPage));
    sizes.push(p?.data.length ?? 0);
    overridden.push(p !== null);
  }
  setSystemRomPageLabels(labels);
  setSystemRomPageSizes(sizes);
  setSystemRomPageOverridden(overridden);

  setCartridgeName(asMsx(machine)?.cartridgeName ?? spectrum?.interface2.name ?? '');
}

/** Replace the current machine's system ROM (BIOS) with a user-supplied image
 *  and reboot into it. Persisted per model so the choice survives a reload.
 *  Generic across machines — the ROM pane calls this for any active model. */
export async function setSystemRom(data: Uint8Array, label: string): Promise<void> {
  if (spectrum) { await spectrum.services.roms.setSystemRom(data, label); return; }
  await persistROM(effectiveROMModel(currentModelValue()), data, label);
  await switchModel(currentModelValue());   // rebuild with the new ROM
}

/** Restore the current model's default system ROM (cleared, then re-fetched). */
export async function resetSystemRom(): Promise<void> {
  if (spectrum) { await spectrum.services.roms.resetSystemRom(); return; }
  await romManager.clearROM(effectiveROMModel(currentModelValue()));
  await switchModel(currentModelValue());   // restoreROM now misses → default is fetched
}

/**
 * Replace one 16K page of a multi-page model's system ROM (128K/+2 — 2 pages;
 * +2A/+3 — 4 pages; see romPageSlotCount). A combined image spanning every
 * page splits across all of them regardless of which slot triggered the
 * load — matching the real ROM's layout — so loading a full image into any
 * one slot "just works". Each page then shows the source filename with its
 * bank number, e.g. "plus3.rom (bank 2)", rather than a generic marker.
 */
export async function setSystemRomPage(page: RomPage, data: Uint8Array, label: string): Promise<void> {
  if (spectrum) { await spectrum.services.roms.setSystemRom(data, label, page); return; }
  const model = effectiveROMModel(currentModelValue());
  const pageCount = romPageSlotCount(model);
  if (pageCount === 0) { setStatus('This model has a single System ROM'); return; }

  if (data.length >= pageCount * BANK_SIZE) {
    for (let i = 0; i < pageCount; i++) {
      await romManager.persistROMPage(model, i as RomPage, data.subarray(i * BANK_SIZE, (i + 1) * BANK_SIZE), `${label} (bank ${i + 1})`);
    }
  } else {
    await romManager.persistROMPage(model, page, data.subarray(0, BANK_SIZE), label);
  }
  await switchModel(currentModelValue());
}

/** Revert one page of a multi-page model's system ROM to its default. */
export async function resetSystemRomPage(page: RomPage): Promise<void> {
  if (spectrum) { await spectrum.services.roms.resetSystemRom(page); return; }
  const model = effectiveROMModel(currentModelValue());
  await romManager.clearROMPage(model, page);
  await switchModel(currentModelValue());
}

// ── ROM image loading ─────────────────────────────────────────────────────

export async function applyROM(data: Uint8Array, fileLabel: string): Promise<void> {
  setRomData(data);

  // Spectrum ROM-image drop. A CPC active here falls back to a 128K default.
  const cur: SpectrumModel = isCpcModel(currentModelValue()) ? '128k' : currentModelValue() as SpectrumModel;
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

/** Try to switch to a 128K-class ROM. createMachine() destroys the old
 *  machine and installs a new one, so hand the caller the new Spectrum (and
 *  its model) to re-bind to. Returns null if no 128K ROM is available. */
export async function ensure128kROM(): Promise<{ spectrum: Spectrum; model: SpectrumModel } | null> {
  const models: SpectrumModel[] = ['128k', '+2', '+2A', '+3'];
  for (const model of models) {
    const entry = await restoreROM(model);
    if (entry) {
      setCurrentModel(model);
      setRomData(entry.data);
      setRomStatus('');
      await createMachine();
      return spectrum ? { spectrum, model } : null;
    }
  }
  return null;
}

// ── Generic peripheral-ROM fulfiller ───────────────────────────────────────
//
// Each machine's prepare()/bootRoms() hooks return AuxRomRequests; the shell
// fetches (IndexedDB-cached, CDN on miss), reports status, sets/clears the
// per-peripheral failure signal, and hands the bytes back via request.apply().
// The peripheral-specific knowledge (URL, cache key, chip wiring, messages)
// stays in the machine folder — this loop is machine-agnostic.

/** Failure-signal setters keyed by AuxRomRequest.failId. Peripheral-keyed, not
 *  machine-kind-keyed: any machine may contribute a request under these ids. */
const FAIL_SETTERS: Record<string, (msg: string) => void> = {
  multiface: setMultifaceRomFailed,
  vtx5000: setVtx5000RomFailed,
  plusd: setPlusDRomFailed,
  betadisk: setBetaDiskRomFailed,
  interface1: setInterface1RomFailed,
  parados: setParadosRomFailed,
};

/** Fetch (IndexedDB-cached, CDN on miss) and wire in one peripheral ROM.
 *  Returns true on success. */
export async function loadAuxRom(r: AuxRomRequest): Promise<boolean> {
  let data = await dbLoad(r.cacheKey);
  if (!data) {
    try {
      setStatus(r.fetchingMsg);
      const resp = await fetch(r.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = new Uint8Array(await resp.arrayBuffer());
      await dbSave(r.cacheKey, data);
    } catch (err) {
      console.warn(`Failed to fetch ${r.failId} ROM:`, err);
      setStatus(r.failMsg);
      FAIL_SETTERS[r.failId]?.(r.failMsg);
      return false;
    }
  }
  r.apply(data);
  setStatus(r.loadedMsg(data.length));
  FAIL_SETTERS[r.failId]?.('');
  return true;
}

/**
 * Fulfil a machine's peripheral-ROM requests. Requests flagged `awaitLoad` are
 * completed in order before returning (their ROM must be present before the
 * machine is reset); the rest are fired and forgotten (Multiface is paged only
 * on its button press).
 */
export async function fulfillAuxRoms(requests: AuxRomRequest[]): Promise<void> {
  for (const r of requests) {
    if (r.awaitLoad) await loadAuxRom(r);
    else loadAuxRom(r).catch(err => console.warn('Aux ROM load failed:', err));
  }
}

// ── Thin per-peripheral wrappers (Hardware pane live-enable path) ───────────
// The Hardware pane toggles a peripheral on, sets the enable flag on the machine
// itself, then calls one of these to fetch just that peripheral's ROM.

export function loadMultifaceROM(s: Spectrum): Promise<boolean> { return loadAuxRom(multifaceAuxRom(s)); }
export function loadVTX5000ROM(s: Spectrum): Promise<boolean> { return loadAuxRom(vtx5000AuxRom(s)); }
export function loadPlusDROM(s: Spectrum): Promise<boolean> { return loadAuxRom(plusDAuxRom(s)); }
export function loadInterface1ROM(s: Spectrum): Promise<boolean> { return loadAuxRom(if1AuxRom(s)); }
export function loadBetaDiskROM(s: Spectrum): Promise<boolean> { return loadAuxRom(betaAuxRom(s)); }
