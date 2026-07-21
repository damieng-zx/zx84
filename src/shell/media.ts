/**
 * Shell media orchestration: the machine-agnostic half of loading and saving
 * media. Zip unwrapping, the multi-file picker, download helpers, reflecting a
 * MediaService mount into the shell's state signals + persistence, the tape and
 * disk transport wrappers, the per-kind tape stash, and joystick/mouse routing.
 *
 * Everything "which device inside this machine" is the machine's business (its
 * services); the shell routes zips, reflects results, and persists. Behaviour
 * differences between machines are declared by their descriptors (zipPolicy,
 * persistMedia, bootDisk, tape family) — no machine-kind branches here.
 */

import { batch } from 'solid-js';
import type { Machine, MountResult, TapeStashState } from '@/machines/machine.ts';
import type { MachineKind } from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { parseFloppyImage, parseHFE, serializeHFE, isHFE, attachHfeBitstream } from '@/media/floppy/hfe.ts';
import { parseSCP, isScp } from '@/media/floppy/scp.ts';
import { parseMgt, serializeMgt, blankMgtDisk, mgtExtFromName } from '@/media/floppy/mgt-image.ts';
import { parseTrd, serializeTrd, blankTrdDisk } from '@/media/floppy/trd-image.ts';
import { parseScl, serializeScl, isScl, SCL_DISK_FORMAT } from '@/media/floppy/scl-image.ts';
import { parseMdrBlocks } from '@/media/microdrive.ts';
import { unzip } from '@/media/zip.ts';
import { parseCasBlocks } from '@/media/tape/cas.ts';
import { showFilePicker } from '@/ui/zip-picker.ts';
import * as settings from '@/store/settings.ts';
import {
  persistLastFile, persistTape, clearTape, restoreTape, persistDisk, restoreDisk, clearDisk,
  persistPlusDDisk, restorePlusDDisk, clearPlusDDisk,
  persistBetaDiskDisk, restoreBetaDiskDisk, clearBetaDiskDisk,
  persistMicrodrive, restoreMicrodrive, clearMicrodrive,
  persistCartridge, restoreCartridge, clearCartridge,
} from '@/store/persistence.ts';
import { entryForModel } from '@/machines/registry.ts';
import {
  tapeName,
  setTapeLoaded, setTapeName, setTapeBlocks, setCasBlocks, setCasPosition,
  setTapePosition, setTapePaused, setTapePlaying,
} from '@/state/tape-state.ts';
import {
  currentModel, emulationPaused,
  setTurboMode, setCartridgeName as setCartridgeNameSig,
} from '@/state/machine-state.ts';
import {
  currentDiskName, currentDiskNameB, currentDiskNameC, currentDiskNameD,
  setCurrentDiskInfo, setCurrentDiskName, setCurrentDiskInfoB, setCurrentDiskNameB,
  setDiskInfoHtml, setDiskSideA, setDiskSideB,
  setCurrentDiskInfoC, setCurrentDiskNameC, setCurrentDiskInfoD, setCurrentDiskNameD,
} from '@/state/disk-state.ts';
import { setTranscribeMode, transcribeMode } from '@/state/activity-state.ts';
import { microdriveSlots, setMicrodriveSlot, clearMicrodriveSlot } from '@/state/microdrive-state.ts';
import { machine, romData, setStatus, romManager } from '@/shell/context.ts';
import { unpause } from '@/shell/lifecycle.ts';
import type { SpectrumModel } from '@/models.ts';

// ── Cassette / cartridge ──────────────────────────────────────────────────

/** Reflect a mounted instant-load cassette into the tape-pane signals + storage. */
function reflectInstantCassette(data: Uint8Array, name: string): void {
  batch(() => {
    setTapeLoaded(true);
    setTapeName(name);
    setTapeBlocks([]);
    setCasBlocks(parseCasBlocks(data));
    setCasPosition(0);   // highlight the first block, as TAP/TZX do on load
    setTapePosition(0);
    setTapePaused(true);
    setTapePlaying(false);
  });
  // Persist under the machine's own platform key so a reload restores it.
  persistTape(machine!.kind, data, name);
}

/** Mount an instant-load cassette (.cas) and reflect it in the tape signals. */
export function mountMsxCassette(data: Uint8Array, name: string): void {
  const tape = machine?.descriptor.ui.tape === 'instant' ? machine.services.tape : null;
  if (!tape) { setStatus('Cassettes are for the MSX'); return; }
  void tape.mountBytes(data, name);   // instant mount — resolves synchronously
  reflectInstantCassette(data, name);
}

/** Insert a cartridge and reboot into it (MSX slot scan / IF2 power-cycle). */
function insertCartridge(data: Uint8Array, name: string, missingMsg: string): void {
  const slot = machine?.services.roms.cartridge;
  if (!slot) { setStatus(missingMsg); return; }
  slot.insert(data, name);   // power-cycles the machine (stop → insert → reset)
  setCartridgeNameSig(name);
  setStatus(`Cartridge: ${name}`);
  if (romData) machine!.start();
}

export function insertMsxCartridge(data: Uint8Array, name: string): void {
  insertCartridge(data, name, 'Cartridges are for the MSX');
}

export function insertIf2Cartridge(data: Uint8Array, name: string): void {
  insertCartridge(data, name, 'Cartridges need a 16K/48K Spectrum');
}

/** Remove the cartridge and reboot to the system ROM/BASIC. */
export function ejectCartridge(): void {
  const m = machine;
  const slot = m?.services.roms.cartridge;
  if (!m || !slot) return;
  slot.eject();   // power-cycles the machine (stop → eject → reset)
  setCartridgeNameSig('');
  setStatus('Cartridge ejected');
  if (m.descriptor.ui.bootCartridge) {
    // No on-board ROM: drop the persisted cartridge and fall back to the hidden
    // default firmware cartridge (re-mounts + reboots), rather than a blank slot.
    clearCartridge(m.kind);
    void applyBootCartridge();
  } else if (romData) {
    m.start();
  }
}

export const ejectMsxCartridge = ejectCartridge;
export const ejectIf2Cartridge = ejectCartridge;

// ── Tape / disk loading ────────────────────────────────────────────────────

export async function applyTape(data: Uint8Array, filename: string): Promise<void> {
  if (!machine) { setStatus('Load a ROM first'); return; }
  const result = await machine.services.media.mount(data, filename);
  await reflectMount(result, data, filename);
}

/**
 * File extensions the current machine can load, for the Load picker filter:
 * the machine's MediaService declares its loadable set; the shell appends .zip
 * when the machine's zip policy allows archives.
 */
export function loadableExtensions(): string[] {
  if (!machine) return ['.sna', '.z80', '.szx', '.sp', '.tap', '.tzx', '.csw', '.zip'];
  const exts = machine.services.media.accepts().map(t => t.ext);
  if (machine.descriptor.ui.zipPolicy !== 'none') exts.push('.zip');
  return exts;
}

export async function loadFile(data: Uint8Array, filename: string, unit?: number): Promise<void> {
  if (!machine) { setStatus('Load a ROM first'); return; }
  // ZIP archives are a machine-agnostic shell concern: unwrap, pick, re-dispatch.
  if (/\.zip$/i.test(filename)) {
    await handleZip(data, unit);
    return;
  }
  // Everything else routes through the active machine's own MediaService.
  const result = await machine.services.media.mount(data, filename, unit !== undefined ? `unit:${unit}` : undefined);
  await reflectMount(result, data, filename, unit);
}

/**
 * Reflect a MediaService mount into the shell's signals / persistence / status.
 * Persistence policy is descriptor-declared: tapes persist for every machine
 * (per-kind keys); disks/snapshots only where `ui.persistMedia` is set (the
 * Spectrum — CPC/Einstein disks were always session-only).
 */
async function reflectMount(
  result: MountResult,
  data: Uint8Array,
  filename: string,
  unit?: number,
): Promise<void> {
  if (result.replay) {
    // The mount triggered a model rebuild: the old machine is gone — re-dispatch.
    await loadFile(data, filename, unit);
    return;
  }
  if (!result.ok || !machine) { setStatus(result.message); return; }
  const m = machine;
  const persistMedia = m.descriptor.ui.persistMedia;
  const target = result.target ?? '';
  if (target === 'tape') {
    batch(() => {
      setTapeLoaded(true);
      setTapeName(filename);
      setTapeBlocks([...(m.services.tape?.rawBlocks ?? [])]);
      setTapePosition(0);
      setTapePaused(true);
      setTapePlaying(true);
    });
    unpause();
    persistLastFile(data, filename);
    persistTape(m.kind, data, filename);
  } else if (target === 'a' || target === 'b') {
    const u = target === 'a' ? 0 : 1;
    const image = m.services.disks?.image?.(target) ?? null;
    if (u === 0) {
      // A real disk in drive 0 supersedes the Einstein's phantom Xtal DOS disk.
      einsteinXtalDosPhantom = false;
      setCurrentDiskInfo(image); setCurrentDiskName(filename);
    } else {
      setCurrentDiskInfoB(image); setCurrentDiskNameB(filename);
    }
    if (persistMedia) {
      if (u === 0) persistLastFile(data, filename);
      persistDisk(u, data, filename);
    }
  } else if (target.startsWith('plusd:')) {
    const u = Number(target.slice(6));
    setPlusDDiskState(u, m.services.disks?.image?.(target) ?? null, filename);
    persistPlusDDisk(u, data, filename);
  } else if (target.startsWith('beta:')) {
    const u = Number(target.slice(5));
    setPlusDDiskState(u, m.services.disks?.image?.(target) ?? null, filename);
    persistBetaDiskDisk(u, data, filename);
  } else if (target.startsWith('mdv:')) {
    const u = Number(target.slice(4));
    const drive = m.services.disks?.drives.find(d => d.id === target);
    setMicrodriveSlot(u, { loaded: true, name: filename, writeProtected: drive?.writeProtected ?? false, modified: false, blocks: parseMdrBlocks(data) });
    persistMicrodrive(u, data, filename).catch((e) => console.warn('persistMicrodrive failed:', e));
  } else if (target === 'cas') {
    reflectInstantCassette(data, filename);
  } else if (target === 'cartridge') {
    setCartridgeNameSig(filename);
    // A real user cartridge supersedes any hidden default-firmware cartridge and
    // is persisted across reloads (machines that declare bootCartridge only).
    if (m.descriptor.ui.bootCartridge) persistCartridge(m.kind, data, filename);
    if (romData) m.start();
  } else if (target === 'snapshot') {
    if (persistMedia) {
      persistLastFile(data, filename);
      unpause();
    }
  }
  setStatus(result.message);
}

/** Unwrap a .zip and re-dispatch its (relevant) contents through loadFile. The
 *  machine's zip policy decides: offer every entry ('all'), only entries its
 *  MediaService accepts ('media'), or reject archives outright ('none'). */
async function handleZip(data: Uint8Array, unit?: number): Promise<void> {
  if (!machine) return;
  const policy = machine.descriptor.ui.zipPolicy;
  const accepted = machine.services.media.accepts().map(t => t.ext);
  if (policy === 'none') {
    setStatus(`ZIP archives are not supported here — load ${accepted.join(', ')} files directly`);
    return;
  }
  let entries;
  try { entries = await unzip(data); } catch (e) { setStatus(`ZIP error: ${(e as Error).message}`); return; }
  const candidates = policy === 'media'
    ? entries.filter(e => accepted.some(ext => e.name.toLowerCase().endsWith(ext)))
    : entries;
  if (candidates.length === 0) {
    setStatus(policy === 'media' ? `ZIP has no loadable media (${accepted.join('/')})` : 'ZIP is empty');
    return;
  }
  let picked = candidates[0];
  if (candidates.length > 1) {
    const name = await showFilePicker(candidates.map(m => m.name));
    if (!name) { setStatus('No file selected'); return; }
    picked = candidates.find(m => m.name === name)!;
  }
  await loadFile(picked.data, picked.name, unit);   // re-dispatch the extracted image
}

// ── Download / save ────────────────────────────────────────────────────────

function downloadFile(data: Uint8Array, filename: string): void {
  const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Save the running CPC as a `.SNA` (v2 = flat, v3 = RLE-compressed). The
 *  Load/Save pane shows this menu only for `ui.saveMenu === 'cpc'`. */
export function saveCpcSnapshot(version: 2 | 3): void {
  const m = machine;
  const cpcSnapshots = m?.descriptor.ui.saveMenu === 'cpc' ? m.services.snapshots : null;
  if (!m || !cpcSnapshots) { setStatus('No CPC running'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) m.stop();

  const data = (cpcSnapshots as unknown as { saveSna(v: 2 | 3): Uint8Array }).saveSna(version);
  downloadFile(data, `zx84-${m.model}.sna`);

  if (!wasPaused) m.start();
  setStatus(`Saved zx84-${m.model}.sna (v${version})`);
}

export async function saveSnapshot(format: 'z80' | 'szx' = 'szx'): Promise<void> {
  const snapshots = machine?.services.snapshots;
  if (!machine || !snapshots) { setStatus('No machine running'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) machine.stop();

  const model = currentModel() as SpectrumModel;
  const data = await snapshots.save(format);
  const filename = `zx84-${model.replace('+', 'plus')}.${format}`;

  downloadFile(data, filename);

  if (!wasPaused) machine.start();
  setStatus(`Saved ${filename}`);
}

export function saveScreenshot(format: 'png' | 'scr'): void {
  if (!machine) { setStatus('No machine running'); return; }

  if (format === 'scr') {
    const screenData = machine.services.debug.screenExport();
    if (!screenData) { setStatus('.scr not supported for this machine'); return; }
    downloadFile(screenData, 'screen.scr');
    setStatus('Saved screen.scr');
  } else {
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
  if (!machine) { setStatus('No machine running'); return; }

  const ram = machine.services.debug.ramExport();
  if (!ram) { setStatus('RAM save not supported for this machine'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) machine.stop();
  downloadFile(ram.data, ram.filename);
  if (!wasPaused) machine.start();
  setStatus(`Saved ${ram.filename}`);
}

// ── Tape transport ──────────────────────────────────────────────────────

export function tapeRewind(): void {
  if (!machine) return;
  machine.services.tape?.rewind();
  setTapePosition(0);
}

export function tapePrev(): void {
  const svc = machine?.services.tape;
  if (!svc) return;
  const pos = svc.position;
  if (pos > 0) svc.seek(pos - 1);
  setTapePosition(svc.position);
}

export function tapeTogglePlay(): void {
  const svc = machine?.services.tape;
  if (!svc) return;
  if (svc.playing) {
    svc.stop();
    setTapePlaying(false);
  } else {
    svc.play();
    setTapePaused(false);
    setTapePlaying(true);
  }
}

export function tapeTogglePause(): void {
  const svc = machine?.services.tape;
  if (!svc) return;
  if (svc.paused) svc.resume();
  else svc.pause();
  setTapePaused(svc.paused);
}

export function tapeNext(): void {
  const svc = machine?.services.tape;
  if (!svc) return;
  const pos = svc.position;
  if (pos < svc.rawBlocks.length) svc.seek(pos + 1);
  setTapePosition(svc.position);
}

export function tapeSetPosition(pos: number): void {
  const svc = machine?.services.tape;
  if (!svc) return;
  svc.seek(pos);
  setTapePosition(pos);
}

export function toggleAutoRewind(): void {
  settings.setTapeAutoRewind(!settings.tapeAutoRewind());
  settings.persistSetting('tape-auto-rewind', settings.tapeAutoRewind() ? 'on' : 'off');
}

export function ejectTape(): void {
  if (!machine) return;
  machine.services.tape?.eject();
  batch(() => {
    setTapeLoaded(false);
    setTapeName('');
    setTapeBlocks([]);
    setCasBlocks([]);
    setCasPosition(-1);
    setTapePosition(0);
    setTapePaused(true);
    setTapePlaying(false);
  });
  clearTape(machine.kind);
  setStatus(machine.descriptor.ui.tape === 'instant' ? 'Cassette ejected' : 'Tape ejected');
}

/**
 * Download the currently loaded tape, byte-for-byte as it was loaded.
 */
export async function saveTape(): Promise<void> {
  if (!machine) { setStatus('No tape to save'); return; }
  const tape = await restoreTape(machine.kind);
  if (!tape) { setStatus('No tape to save'); return; }
  downloadFile(tape.data, tape.name);
}

// ── Disk transport (built-in drives A:/B:) ─────────────────────────────────

export function ejectDisk(unit: number = 0): void {
  const disks = machine?.services.disks;
  if (!machine || !disks) return;
  disks.eject(unit === 0 ? 'a' : 'b');
  clearDisk(unit);
  if (unit === 0) {
    setCurrentDiskInfo(null);
    setCurrentDiskName('');
    setDiskInfoHtml('');
    setDiskSideA(0);
  } else {
    setCurrentDiskInfoB(null);
    setCurrentDiskNameB('');
    setDiskSideB(0);
  }
  setStatus(`Disk ${unit === 0 ? 'A' : 'B'}: ejected`);
  // Ejecting a real disk from drive 0 may re-expose the phantom boot disk.
  if (unit === 0 && machine.descriptor.ui.bootDisk) {
    einsteinXtalDosPhantom = false;
    applyEinsteinXtalDosDisk();
  }
}

export function insertBlankDisk(image: DskImage, name: string, unit: number): void {
  const disks = machine?.services.disks;
  if (!machine || !disks) return;
  disks.insert(unit === 0 ? 'a' : 'b', image, name);
  if (unit === 0) {
    einsteinXtalDosPhantom = false;   // a real disk now occupies drive 0
    setCurrentDiskInfo(image);
    setCurrentDiskName(name);
  } else {
    setCurrentDiskInfoB(image);
    setCurrentDiskNameB(name);
  }
}

// ── Phantom auto-boot disk (Einstein "Xtal DOS" hardware option) ───────────

let einsteinXtalDosImage: DskImage | null = null;
let einsteinXtalDosPhantom = false;

/** Reset the phantom flag (a fresh FDC on the new machine). Called by lifecycle
 *  on every machine (re)build. */
export function resetEinsteinPhantom(): void { einsteinXtalDosPhantom = false; }

/** Reconcile the phantom boot disk with the current option + drive-0 state. */
export async function applyEinsteinXtalDosDisk(): Promise<void> {
  const m = machine;
  if (!m || !m.descriptor.ui.bootDisk) { einsteinXtalDosPhantom = false; return; }
  const want = settings.einsteinXtalDos() && currentDiskName() === '';
  if (want && !einsteinXtalDosPhantom) {
    if (!einsteinXtalDosImage) {
      const data = await romManager.fetchEinsteinXtalDosDisk();
      if (!data) return;                       // unavailable → option is a no-op
      try { einsteinXtalDosImage = parseFloppyImage(data); } catch { return; }
    }
    if (machine === m && settings.einsteinXtalDos() && currentDiskName() === '') {
      m.services.disks?.insert('a', einsteinXtalDosImage, '');
      einsteinXtalDosPhantom = true;
    }
  } else if (!want && einsteinXtalDosPhantom) {
    m.services.disks?.eject('a');
    einsteinXtalDosPhantom = false;
  }
}

// ── Phantom default boot cartridge (machines with no on-board ROM) ─────────

/**
 * Boot the cartridge slot for machines that declare `ui.bootCartridge` (CPC
 * Plus / GX4000). Restores a persisted user cartridge if one exists; otherwise
 * hidden-mounts the machine's default firmware cartridge with an empty name, so
 * the ROM pane shows the slot as unoccupied (a real cartridge is the only thing
 * with a name). A user cartridge later supersedes it (see reflectMount);
 * ejecting re-exposes it. Machine-agnostic — the image source comes from the
 * machine entry's `bootCartridgeSource` hook.
 */
export async function applyBootCartridge(): Promise<void> {
  const m = machine;
  if (!m || !m.descriptor.ui.bootCartridge) return;
  const slot = m.services.roms.cartridge;
  if (!slot || slot.name !== '') return;   // no slot, or a real cartridge already in

  // A user cartridge persisted from a previous session takes precedence.
  const saved = await restoreCartridge(m.kind);
  if (saved && machine === m && slot.name === '') {
    try {
      slot.insert(saved.data, saved.name);
      setCartridgeNameSig(saved.name);
      setStatus(`Cartridge: ${saved.name}`);
      return;
    } catch { /* corrupt persisted cart → fall through to the default firmware */ }
  }

  // Otherwise hidden-mount the machine's default firmware cartridge.
  const source = entryForModel(m.model).bootCartridgeSource?.(m.model);
  if (!source) return;
  const data = await romManager.fetchBootCartridge(source);
  if (data && machine === m && slot.name === '') {
    slot.insert(data, '');   // empty name → shown as not mounted
  }
}

/** Toggle the "Xtal DOS" hardware option and apply it immediately. */
export function setEinsteinXtalDosEnabled(on: boolean): void {
  settings.setEinsteinXtalDos(on);
  settings.persistSetting('einstein-xtaldos', on ? 'on' : 'off');
  applyEinsteinXtalDosDisk();
}

/**
 * Flip a combined "flippy" disk in drive `unit` (0 = A:, 1 = B:) to its other side.
 */
export function flipDisk(unit: number): void {
  const disks = machine?.services.disks;
  if (!disks?.flipSide) return;
  const newSide = disks.flipSide(unit === 0 ? 'a' : 'b');
  if (newSide === null) return;
  if (unit === 0) setDiskSideA(newSide); else setDiskSideB(newSide);
  setStatus(`Disk ${unit === 0 ? 'A' : 'B'}: flipped to Side ${newSide ? 'B' : 'A'}`);
}

export function saveDisk(unit: number): void {
  const disks = machine?.services.disks;
  if (!machine || !disks) return;
  const saved = disks.save(unit === 0 ? 'a' : 'b');
  if (!saved) { setStatus(`No disk in drive ${unit === 0 ? 'A' : 'B'}:`); return; }
  // Keep the pane's mounted name (the service falls back to a generic base).
  const name = unit === 0 ? currentDiskName() : currentDiskNameB();
  const base = name.replace(/\.[^.]+$/, '');
  const ext = saved.name.slice(saved.name.lastIndexOf('.'));
  downloadFile(saved.data, base ? `${base}${ext}` : saved.name);
}

export function loadDiskToUnit(data: Uint8Array, filename: string, unit: number): void {
  const disks = machine?.services.disks;
  if (!machine || !disks) { setStatus('Load a ROM first'); return; }
  const id = unit === 0 ? 'a' : 'b';
  machine.stop();
  try {
    const image = parseFloppyImage(data);
    disks.insert(id, image, filename);
    if (unit === 0) {
      einsteinXtalDosPhantom = false;
      setCurrentDiskInfo(image); setCurrentDiskName(filename);
    } else {
      setCurrentDiskInfoB(image); setCurrentDiskNameB(filename);
    }
    if (machine.descriptor.ui.persistMedia) {
      if (unit === 0) persistLastFile(data, filename);
      persistDisk(unit, data, filename);
    }
    setStatus(`Disk ${unit === 0 ? 'A' : 'B'}: loaded: ${filename}`);
  } catch (e) {
    setStatus(`Disk error: ${(e as Error).message}`);
  } finally {
    machine.start();
  }
}

// ── MGT +D disk helpers (drives C/D = WD1772 units 0/1) ──────────────────

function setPlusDDiskState(unit: number, image: DskImage | null, name: string): void {
  if (unit === 0) { setCurrentDiskInfoC(image); setCurrentDiskNameC(name); }
  else { setCurrentDiskInfoD(image); setCurrentDiskNameD(name); }
}

/** True when the active machine currently offers drive id `id`. */
function hasDrive(id: string): boolean {
  return machine?.services.disks?.drives.some(d => d.id === id) ?? false;
}

/** Load a .mgt/.img/.hfe image into a +D drive (unit 0/1 → C:/D:). */
export function loadPlusDDisk(data: Uint8Array, filename: string, unit: number): void {
  if (!machine) { setStatus('Load a ROM first'); return; }
  if (!hasDrive(`plusd:${unit}`)) { setStatus('Enable the MGT +D in Hardware first'); return; }
  let image: DskImage | null;
  try {
    image = isHFE(data) ? parseHFE(data) : isScp(data) ? parseSCP(data) : parseMgt(data, mgtExtFromName(filename));
  } catch (e) {
    setStatus(`+D disk error: ${(e as Error).message}`);
    return;
  }
  if (!image) { setStatus(`Not a recognised +D image: ${filename}`); return; }
  machine.stop();
  try {
    machine.services.disks!.insert(`plusd:${unit}`, image, filename);
    setPlusDDiskState(unit, image, filename);
    persistPlusDDisk(unit, data, filename);
    setStatus(`+D disk ${unit === 0 ? 'C' : 'D'}: loaded: ${filename}`);
  } finally {
    machine.start();
  }
}

export function ejectPlusDDisk(unit: number): void {
  if (!machine || !hasDrive(`plusd:${unit}`)) return;
  machine.services.disks!.eject(`plusd:${unit}`);
  clearPlusDDisk(unit);
  setPlusDDiskState(unit, null, '');
  setStatus(`+D disk ${unit === 0 ? 'C' : 'D'}: ejected`);
}

/** Blank +D geometries offered in the UI (all 10 × 512-byte sectors). */
export interface PlusDBlankGeometry { tracks: number; sides: number; }

export function insertBlankPlusDDisk(unit: number, geom: PlusDBlankGeometry, asHfe = false): void {
  if (!machine || !hasDrive(`plusd:${unit}`)) return;
  const base = blankMgtDisk(geom.tracks, geom.sides);
  const image = asHfe ? attachHfeBitstream(base) : base;
  const [name, data] = asHfe
    ? ['BLANK.hfe', serializeHFE(image)]
    : ['BLANK.mgt', serializeMgt(image, 'mgt')];
  machine.services.disks!.insert(`plusd:${unit}`, image, name);
  setPlusDDiskState(unit, image, name);
  persistPlusDDisk(unit, data, name);
}

export function savePlusDDisk(unit: number): void {
  if (!machine || !hasDrive(`plusd:${unit}`)) return;
  const saved = machine.services.disks!.save(`plusd:${unit}`);
  if (!saved) { setStatus(`No disk in +D drive ${unit === 0 ? 'C' : 'D'}:`); return; }
  const name = unit === 0 ? currentDiskNameC() : currentDiskNameD();
  const base = name.replace(/\.[^.]+$/, '') || 'plusd';
  const ext = saved.name.slice(saved.name.lastIndexOf('.'));
  downloadFile(saved.data, `${base}${ext}`);
}

// ── Beta Disk (TR-DOS) helpers (WD1793 units 0/1) ────────────────────────

/** Load a .trd/.scl/.hfe image into a Beta Disk drive (unit 0/1). */
export function loadBetaDiskDisk(data: Uint8Array, filename: string, unit: number): void {
  if (!machine) { setStatus('Load a ROM first'); return; }
  if (!hasDrive(`beta:${unit}`)) { setStatus('Enable the Beta Disk in Hardware first'); return; }
  let image: DskImage | null;
  try {
    if (isHFE(data)) image = parseHFE(data);
    else if (isScp(data)) image = parseSCP(data);
    else if (isScl(data)) image = parseScl(data);
    else image = parseTrd(data);
  } catch (e) {
    setStatus(`Beta Disk error: ${(e as Error).message}`);
    return;
  }
  if (!image) { setStatus(`Not a recognised Beta Disk image: ${filename}`); return; }
  machine.stop();
  try {
    machine.services.disks!.insert(`beta:${unit}`, image, filename);
    setPlusDDiskState(unit, image, filename);
    persistBetaDiskDisk(unit, data, filename);
    setStatus(`Beta Disk ${unit === 0 ? 'A' : 'B'}: loaded: ${filename}`);
  } finally {
    machine.start();
  }
}

export function ejectBetaDiskDisk(unit: number): void {
  if (!machine || !hasDrive(`beta:${unit}`)) return;
  machine.services.disks!.eject(`beta:${unit}`);
  clearBetaDiskDisk(unit);
  setPlusDDiskState(unit, null, '');
  setStatus(`Beta Disk ${unit === 0 ? 'A' : 'B'}: ejected`);
}

/** Blank TR-DOS geometries offered in the UI (all 16 × 256-byte sectors). */
export interface BetaDiskBlankGeometry { tracks: number; sides: number; }

export function insertBlankBetaDiskDisk(unit: number, geom: BetaDiskBlankGeometry = { tracks: 80, sides: 2 }, asScl = false): void {
  if (!machine || !hasDrive(`beta:${unit}`)) return;
  const image = asScl ? blankTrdDisk(80, 2) : blankTrdDisk(geom.tracks, geom.sides);
  if (asScl) image.diskFormat = SCL_DISK_FORMAT;
  const [name, data] = asScl ? ['BLANK.scl', serializeScl(image)] : ['BLANK.trd', serializeTrd(image)];
  machine.services.disks!.insert(`beta:${unit}`, image, name);
  setPlusDDiskState(unit, image, name);
  persistBetaDiskDisk(unit, data, name);
}

export function saveBetaDiskDisk(unit: number): void {
  if (!machine || !hasDrive(`beta:${unit}`)) return;
  const saved = machine.services.disks!.save(`beta:${unit}`);
  if (!saved) { setStatus(`No disk in Beta Disk drive ${unit === 0 ? 'A' : 'B'}:`); return; }
  const name = unit === 0 ? currentDiskNameC() : currentDiskNameD();
  const base = name.replace(/\.[^.]+$/, '') || 'betadisk';
  const ext = saved.name.slice(saved.name.lastIndexOf('.'));
  downloadFile(saved.data, `${base}${ext}`);
}

// ── ZX Interface 1 microdrive helpers (drives 1-8 → units 0-7) ───────────

/** Mount an .mdr/.mdv cartridge into a microdrive (unit 0-7 → drive 1-8). */
export function loadMicrodrive(data: Uint8Array, filename: string, unit: number): void {
  if (!machine) { setStatus('Load a ROM first'); return; }
  if (!hasDrive(`mdv:${unit}`)) { setStatus('Enable the ZX Interface 1 in Hardware first'); return; }
  try {
    machine.services.disks!.insert(`mdv:${unit}`, data, filename);
    const drive = machine.services.disks!.drives.find(d => d.id === `mdv:${unit}`);
    setMicrodriveSlot(unit, { loaded: true, name: filename, writeProtected: drive?.writeProtected ?? false, modified: false, blocks: parseMdrBlocks(data) });
    persistMicrodrive(unit, data, filename).catch((e) => console.warn('persistMicrodrive failed:', e));
    setStatus(`Microdrive ${unit + 1}: loaded: ${filename}`);
  } catch (e) {
    console.error('loadMicrodrive failed:', e);
    setStatus(`Microdrive error: ${(e as Error).message}`);
  }
}

export function ejectMicrodrive(unit: number): void {
  if (!machine || !hasDrive(`mdv:${unit}`)) return;
  machine.services.disks!.eject(`mdv:${unit}`);
  clearMicrodrive(unit);
  clearMicrodriveSlot(unit);
  setStatus(`Microdrive ${unit + 1}: ejected`);
}

export function insertBlankMicrodrive(unit: number, name = 'CART'): void {
  // Formatting a blank cartridge is an IF1 FORMAT mechanism (no image codec
  // makes one); the machine's DiskService owns it and hands back the bytes.
  const disks = machine?.services.disks;
  if (!machine || !disks?.formatBlank || !hasDrive(`mdv:${unit}`)) {
    setStatus('Enable the ZX Interface 1 in Hardware first'); return;
  }
  const blank = disks.formatBlank(`mdv:${unit}`, name);
  if (!blank) { setStatus('Enable the ZX Interface 1 in Hardware first'); return; }
  setMicrodriveSlot(unit, { loaded: true, name: blank.name, writeProtected: false, modified: false, blocks: [] });
  persistMicrodrive(unit, blank.data, blank.name);
  setStatus(`Microdrive ${unit + 1}: blank cartridge inserted`);
}

export function saveMicrodrive(unit: number): void {
  if (!machine || !hasDrive(`mdv:${unit}`)) return;
  const saved = machine.services.disks!.save(`mdv:${unit}`);
  if (!saved) { setStatus(`No cartridge in microdrive ${unit + 1}`); return; }
  const base = (microdriveSlots()[unit]?.name || `mdr${unit + 1}`).replace(/\.[^.]+$/, '') || `mdr${unit + 1}`;
  downloadFile(saved.data, `${base}.mdr`);
}

/** Toggle the write-protect tab on a mounted cartridge and re-persist it. */
export function setMicrodriveWriteProtect(unit: number, wp: boolean): void {
  if (!machine || !hasDrive(`mdv:${unit}`)) return;
  const disks = machine.services.disks!;
  const drive = disks.drives.find(d => d.id === `mdv:${unit}`);
  if (!drive?.loaded) return;
  disks.setWriteProtect(`mdv:${unit}`, wp);
  setMicrodriveSlot(unit, { writeProtected: wp });
  const saved = disks.save(`mdv:${unit}`);
  if (saved) persistMicrodrive(unit, saved.data, microdriveSlots()[unit]?.name || `mdr${unit + 1}.mdr`);
}

// ── Joystick / mouse routing ────────────────────────────────────────────

export function joyPressForType(dir: string, pressed: boolean, mode: string, player = 0): void {
  machine?.services.input.joystick?.press(dir, pressed, mode, player);
}

export type MouseMode = 'kempston' | 'amx' | null;

export function setMouseMode(mode: MouseMode): void {
  machine?.services.input.mice?.setMode(mode);
}

export function updateMousePosition(dx: number, dy: number, mode: MouseMode): void {
  machine?.services.input.mice?.motion(dx, dy, mode);
}

export function setMouseButton(button: number, pressed: boolean, mode: MouseMode): void {
  machine?.services.input.mice?.button(button, pressed, mode);
}

// ── Per-kind tape stash (family-independent decks) ─────────────────────────

/** A loaded tape parked while another machine family is active. Decks are kept
 *  independent per platform *kind*: switching across incompatible families
 *  stashes the outgoing tape under its own kind and restores the incoming
 *  kind's own tape (if any). The state itself is machine-provided
 *  (TapeService.stashState — deck blocks or cassette bytes). */
interface TapeStash {
  name: string;
  state: TapeStashState;
}
const tapeStashes: Partial<Record<MachineKind, TapeStash>> = {};

/** Stash the outgoing machine's tape under its own platform kind. */
export function stashOutgoingTape(m: Machine): void {
  const state = m.services.tape?.stashState() ?? null;
  tapeStashes[m.kind] = state ? { name: tapeName(), state } : undefined;
}

/** Restore the tape stashed for the NEW machine's platform kind (if any). */
export function restoreTapeForMachine(m: Machine): void {
  const stash = tapeStashes[m.kind];
  const svc = m.services.tape;
  const clearTapeSignals = () => batch(() => {
    setTapeLoaded(false);
    setTapeName('');
    setTapeBlocks([]);
    setCasBlocks([]);
    setCasPosition(-1);
    setTapePosition(0);
    setTapePaused(true);
    setTapePlaying(false);
    setTurboMode(false);
  });
  if (svc && stash?.state.casData) {
    // Instant cassette: re-mount + reflect (parses the .cas block list).
    svc.restoreStash(stash.state, stash.name);
    reflectInstantCassette(stash.state.casData, stash.name);
    setTurboMode(false);
  } else if (svc && stash?.state.blocks && stash.state.blocks.length > 0) {
    svc.restoreStash(stash.state, stash.name);
    batch(() => {
      setTapeLoaded(true);
      setTapeName(stash.name);
      setTapeBlocks([...stash.state.blocks!]);
      setTapePosition(stash.state.position ?? 0);
      setTapePaused(stash.state.paused ?? true);
      setTapePlaying(false);
      setTurboMode(false);
    });
  } else {
    clearTapeSignals();
  }
}

// ── Restore persisted media (tape + disks) without resetting ─────────

export async function restoreMedia(): Promise<void> {
  if (!machine) return;

  // Restore the tape persisted for THIS platform (kept isolated per machine
  // kind). The machine's TapeService parses its own formats.
  const tape = await restoreTape(machine.kind);
  const tapeSvc = machine.services.tape;
  if (tape && tapeSvc) {
    if (machine.descriptor.ui.tape === 'instant') {
      mountMsxCassette(tape.data, tape.name);   // .cas → instant-load cassette
    } else if (await tapeSvc.mountBytes(tape.data, tape.name)) {
      batch(() => {
        setTapeLoaded(true);
        setTapeName(tape.name);
        setTapeBlocks([...tapeSvc.rawBlocks]);
        setTapePosition(0);
        setTapePaused(true);
        setTapePlaying(false);
      });
    }
  }

  // Restore disks into the built-in drives (uPD765A / WD1772 machines).
  const disks = machine.services.disks;
  if (disks) {
    for (const unit of [0, 1]) {
      const disk = await restoreDisk(unit);
      if (!disk) continue;
      try {
        const image = parseFloppyImage(disk.data);
        disks.insert(unit === 0 ? 'a' : 'b', image, disk.name);
        if (unit === 0) { setCurrentDiskInfo(image); setCurrentDiskName(disk.name); }
        else { setCurrentDiskInfoB(image); setCurrentDiskNameB(disk.name); }
      } catch { /* ignore corrupt data */ }
    }

    // MGT +D drives C:/D: — only when the +D is fitted.
    if (hasDrive('plusd:0')) {
      for (const unit of [0, 1]) {
        const disk = await restorePlusDDisk(unit);
        if (!disk) continue;
        try {
          const image = isHFE(disk.data) ? parseHFE(disk.data)
            : isScp(disk.data) ? parseSCP(disk.data)
            : parseMgt(disk.data, mgtExtFromName(disk.name));
          if (!image) continue;
          disks.insert(`plusd:${unit}`, image, disk.name);
          setPlusDDiskState(unit, image, disk.name);
        } catch { /* ignore corrupt data */ }
      }
    }

    // Beta Disk drives A:/B: — only when the Beta Disk is fitted.
    if (hasDrive('beta:0')) {
      for (const unit of [0, 1]) {
        const disk = await restoreBetaDiskDisk(unit);
        if (!disk) continue;
        try {
          const image = isHFE(disk.data) ? parseHFE(disk.data)
            : isScp(disk.data) ? parseSCP(disk.data)
            : isScl(disk.data) ? parseScl(disk.data)
            : parseTrd(disk.data);
          if (!image) continue;
          disks.insert(`beta:${unit}`, image, disk.name);
          setPlusDDiskState(unit, image, disk.name);
        } catch { /* ignore corrupt data */ }
      }
    }

    // ZX Interface 1 microdrives (drives 1-8) — only when the IF1 is fitted.
    if (hasDrive('mdv:0')) {
      for (let unit = 0; unit < 8; unit++) {
        const cart = await restoreMicrodrive(unit);
        if (!cart) continue;
        try {
          disks.insert(`mdv:${unit}`, cart.data, cart.name);
          const drive = disks.drives.find(d => d.id === `mdv:${unit}`);
          setMicrodriveSlot(unit, { loaded: true, name: cart.name, writeProtected: drive?.writeProtected ?? false, modified: false, blocks: parseMdrBlocks(cart.data) });
        } catch { /* ignore corrupt data */ }
      }
    }
  }
}

// ── Transcribe / renderer ──────────────────────────────────────────────────

export function toggleTranscribeMode(mode: 'text'): void {
  if (transcribeMode() === mode) {
    setTranscribeMode('off');
  } else {
    setTranscribeMode(mode);
  }
}

export function switchRenderer(mode: 'webgl' | 'canvas'): void {
  settings.setRenderer(mode);
  settings.persistSetting('renderer', mode);
}
