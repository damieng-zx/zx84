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
import { parseFloppyImage } from '@/media/floppy/hfe.ts';
import { unzip } from '@/media/zip.ts';
import { showFilePicker } from '@/ui/zip-picker.ts';
import * as settings from '@/store/settings.ts';
import {
  persistLastFile, persistTape, clearTape, restoreTape, persistDisk, restoreDisk, clearDisk,
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
import { machine, romData, setStatus, romManager } from '@/shell/context.ts';
import { unpause } from '@/shell/lifecycle.ts';
import { downloadFile } from '@/shell/download.ts';
import { reflectPeripheralMount, restorePeripheralDrives } from '@/shell/peripheral-drives.ts';

// The Spectrum's add-on drives (+D, Beta Disk, microdrives) live in their own module.
export {
  loadPlusDDisk, ejectPlusDDisk, insertBlankPlusDDisk, savePlusDDisk,
  loadBetaDiskDisk, ejectBetaDiskDisk, insertBlankBetaDiskDisk, saveBetaDiskDisk,
  loadMicrodrive, ejectMicrodrive, insertBlankMicrodrive, saveMicrodrive, setMicrodriveWriteProtect,
} from '@/shell/peripheral-drives.ts';
export type { PlusDBlankGeometry, BetaDiskBlankGeometry } from '@/shell/peripheral-drives.ts';
import type { SpectrumModel } from '@/models.ts';

// ── Cassette / cartridge ──────────────────────────────────────────────────

/** Reflect a mounted instant-load cassette into the tape-pane signals + storage. */
function reflectInstantCassette(data: Uint8Array, name: string): void {
  const blocks = machine?.services.tape?.blocks ?? [];
  batch(() => {
    setTapeLoaded(true);
    setTapeName(name);
    setTapeBlocks([]);
    setCasBlocks([...blocks]);
    setCasPosition(0);   // highlight the first block, as TAP/TZX do on load
    setTapePosition(0);
    setTapePaused(true);
    setTapePlaying(false);
  });
  // Persist under the machine's own platform key so a reload restores it.
  persistTape(machine!.kind, data, name);
}

/** Mount a logical instant-load cassette and reflect it in the tape signals. */
export function mountInstantCassette(data: Uint8Array, name: string): void {
  const tape = machine?.descriptor.ui.tape === 'instant' ? machine.services.tape : null;
  if (!tape) { setStatus('This machine has no instant cassette'); return; }
  void tape.mountBytes(data, name);   // instant mount — resolves synchronously
  reflectInstantCassette(data, name);
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

export interface LoadOptions {
  /** Boot what was just mounted, where that makes sense: a Beta Disk (.trd/.scl)
   *  in drive A is run through TR-DOS. Set by the Load button and drag-and-drop,
   *  where the user is opening a program; not by a drive's own insert, which only
   *  swaps media under a running machine, nor by the library, which boots its own. */
  autoBoot?: boolean;
}

export async function loadFile(data: Uint8Array, filename: string, unit?: number, options: LoadOptions = {}): Promise<void> {
  if (!machine) { setStatus('Load a ROM first'); return; }
  // ZIP archives are a machine-agnostic shell concern: unwrap, pick, re-dispatch.
  if (/\.zip$/i.test(filename)) {
    await handleZip(data, filename, unit, options);
    return;
  }
  // Everything else routes through the active machine's own MediaService.
  const result = await machine.services.media.mount(data, filename, unit !== undefined ? `unit:${unit}` : undefined);
  await reflectMount(result, data, filename, unit, options);
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
  options: LoadOptions = {},
): Promise<void> {
  if (result.replay) {
    // The mount triggered a model rebuild: the old machine is gone — re-dispatch.
    await loadFile(data, filename, unit, options);
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
  } else if (DISK_UNITS.some(x => x.id === target)) {
    const unit = DISK_UNITS.findIndex(x => x.id === target);
    const u = DISK_UNITS[unit];
    // A real disk in drive 0 supersedes any hidden default boot disk.
    if (unit === 0) bootDiskPhantom = false;
    u.setInfo(m.services.disks?.image?.(target) ?? null);
    u.setName(filename);
    if (persistMedia) {
      if (unit === 0) persistLastFile(data, filename);
      persistDisk(unit, data, filename, m.kind);
    }
  } else if (reflectPeripheralMount(m, target, data, filename, options.autoBoot === true)) {
    // add-on drive (+D, Beta Disk, microdrive): reflected and persisted there
  } else if (target === 'cas') {
    reflectInstantCassette(data, filename);
  } else if (target === 'cartridge') {
    setCartridgeNameSig(filename);
    // A real user cartridge supersedes any hidden default-firmware cartridge and
    // is persisted across reloads (machines that declare bootCartridge only).
    if (m.descriptor.ui.bootCartridge) persistCartridge(m.kind, data, filename);
    if (romData) m.start();
  } else if (target === 'snapshot') {
    if (result.mediaChanged) syncMediaFromMachine(m);
    if (persistMedia) {
      persistLastFile(data, filename);
      unpause();
    }
  }
  setStatus(result.message);
}

/**
 * A snapshot that carried its own disks and cassette (the Atari's) has changed
 * what is in the drives and on the tape behind the panes' backs: show it, and
 * persist it so a reload does not bring back what was there before.
 */
function syncMediaFromMachine(m: Machine): void {
  if (m.services.roms.cartridge) setCartridgeNameSig(m.services.roms.cartridge.name);
  const disks = m.services.disks;
  if (disks) {
    DISK_UNITS.forEach((u, unit) => {
      const drive = disks.drives.find(d => d.id === u.id);
      const saved = drive?.loaded ? disks.save(u.id) : null;
      u.setInfo(drive?.loaded ? disks.image?.(u.id) ?? null : null);
      u.setName(drive?.loaded ? drive.mediaName : '');
      if (!drive) return;
      if (saved && m.descriptor.ui.persistMedia) persistDisk(unit, saved.data, drive.mediaName || saved.name, m.kind);
      else if (!saved) clearDisk(unit, m.kind);
    });
  }
  const tape = m.services.tape;
  if (!tape) return;
  const cas = tape.loaded ? tape.stashState()?.casData : undefined;
  if (cas) {
    reflectInstantCassette(cas, tape.name);
  } else {
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
    clearTape(m.kind);
  }
}

/** Unwrap a .zip and re-dispatch its (relevant) contents through loadFile. The
 *  archive is filtered by the machine's own MediaService declaration, so a
 *  format the machine accepts can never be dropped by the ZIP parser; the zip
 *  policy decides: offer every accepted entry ('all'), mount the first
 *  accepted entry ('media'), or reject archives outright ('none'). A machine
 *  that mounts whole archives (MediaService.mountArchive) is offered every
 *  file first. */
async function handleZip(data: Uint8Array, filename: string, unit: number | undefined, options: LoadOptions): Promise<void> {
  if (!machine) return;
  const policy = machine.descriptor.ui.zipPolicy;
  const accepted = machine.services.media.accepts().map(t => t.ext);
  if (policy === 'none') {
    setStatus(`ZIP archives are not supported here — load ${accepted.join(', ')} files directly`);
    return;
  }
  const media = machine.services.media;
  if (media.mountArchive) {
    let all;
    try { all = await unzip(data, ['']); } catch (e) { setStatus(`ZIP error: ${(e as Error).message}`); return; }
    const result = await media.mountArchive(all, filename);
    if (result) { await reflectMount(result, data, filename, unit, options); return; }
  }
  let entries;
  try { entries = await unzip(data, accepted); } catch (e) { setStatus(`ZIP error: ${(e as Error).message}`); return; }
  if (entries.length === 0) {
    setStatus(policy === 'media' ? `ZIP has no loadable media (${accepted.join('/')})` : 'ZIP is empty');
    return;
  }
  let picked = entries[0];
  if (entries.length > 1) {
    const name = await showFilePicker(entries.map(m => m.name));
    if (!name) { setStatus('No file selected'); return; }
    picked = entries.find(m => m.name === name)!;
  }
  await loadFile(picked.data, picked.name, unit, options);   // re-dispatch the extracted image
}

// ── Download / save ────────────────────────────────────────────────────────

/** Save the running CPC as a `.SNA` (v2 = flat, v3 = RLE-compressed). The
 *  Load/Save pane offers this only when the descriptor names the entry. */
export function saveCpcSnapshot(version: 2 | 3): void {
  const m = machine;
  const cpcSnapshots = m?.descriptor.ui.saveMenu.includes('snapshot-sna-v2')
    ? m.services.snapshots
    : null;
  if (!m || !cpcSnapshots) { setStatus('No CPC running'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) m.stop();
  try {
    const data = (cpcSnapshots as unknown as { saveSna(v: 2 | 3): Uint8Array }).saveSna(version);
    downloadFile(data, `zx84-${m.model}.sna`);
  } finally {
    if (!wasPaused) m.start();
  }
  setStatus(`Saved zx84-${m.model}.sna (v${version})`);
}

/** Save the running machine's snapshot in `format` (an extension its
 *  snapshot service saves: 'szx', 'z80', 'a8state', 'acestate', …). */
export async function saveSnapshot(format: string = 'szx'): Promise<void> {
  const snapshots = machine?.services.snapshots;
  if (!machine || !snapshots) { setStatus('No machine running'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) machine.stop();
  const model = currentModel() as SpectrumModel;
  const filename = `zx84-${model}.${format}`;
  try {
    downloadFile(await snapshots.save(format), filename);
  } finally {
    if (!wasPaused) machine.start();
  }
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

/** Download what the machine has SAVEd to its cassette port. Offered only
 *  where the descriptor names 'tape-tap'; the machine owns what it recorded
 *  and what to call it. */
export function saveRecordedTape(): void {
  if (!machine) { setStatus('No machine running'); return; }
  const recorded = machine.services.tape?.recordedBytes?.() ?? null;
  if (!recorded) { setStatus('Nothing has been saved to tape yet'); return; }
  downloadFile(recorded.data, recorded.filename);
  setStatus(`Saved ${recorded.filename}`);
}

export function saveRAM(): void {
  if (!machine) { setStatus('No machine running'); return; }

  const ram = machine.services.debug.ramExport();
  if (!ram) { setStatus('RAM save not supported for this machine'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) machine.stop();
  try {
    downloadFile(ram.data, ram.filename);
  } finally {
    if (!wasPaused) machine.start();
  }
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

// ── Disk transport (built-in drives A:..D:) ─────────────────────────────────

/** Per-unit pane signals for the built-in drives, indexed by unit number. */
interface DiskUnitSignals {
  readonly id: string;
  readonly setInfo: (v: DskImage | null) => void;
  readonly name: () => string;
  readonly setName: (v: string) => void;
  readonly setSide?: (v: number) => void;
}
const DISK_UNITS: readonly DiskUnitSignals[] = [
  { id: 'a', setInfo: setCurrentDiskInfo, name: currentDiskName, setName: setCurrentDiskName, setSide: setDiskSideA },
  { id: 'b', setInfo: setCurrentDiskInfoB, name: currentDiskNameB, setName: setCurrentDiskNameB, setSide: setDiskSideB },
  { id: 'c', setInfo: setCurrentDiskInfoC, name: currentDiskNameC, setName: setCurrentDiskNameC },
  { id: 'd', setInfo: setCurrentDiskInfoD, name: currentDiskNameD, setName: setCurrentDiskNameD },
];

/** One built-in drive's contents, carried across a machine rebuild. */
export interface CarriedDisk {
  readonly id: string;
  readonly image: DskImage;
  readonly name: string;
}

/**
 * Snapshot the built-in drives so a model switch can put them back.
 *
 * Switching *within* a family is the same discs in the same drives — a PCW8256
 * and a PCW8512 differ in RAM and drive count, not in what a disc is — and
 * ejecting them is never what was meant. Switching to another machine is a
 * different story, so the caller restores only when the kind is unchanged.
 */
export function captureBuiltinDisks(): CarriedDisk[] {
  const disks = machine?.services.disks;
  if (!disks) return [];
  const out: CarriedDisk[] = [];
  for (const u of DISK_UNITS) {
    if (!disks.drives.some(d => d.id === u.id)) continue;
    const image = disks.image?.(u.id) ?? null;
    if (!image) continue;
    out.push({ id: u.id, image, name: u.name() });
  }
  return out;
}

/** Put `carried` back into the rebuilt machine's drives, and back on the pane.
 *  Drives the new model has not got (the 8512's B: on an 8256) are dropped. */
export function restoreBuiltinDisks(carried: readonly CarriedDisk[]): void {
  const disks = machine?.services.disks;
  if (!disks) return;
  for (const c of carried) {
    if (!disks.drives.some(d => d.id === c.id)) continue;
    const u = DISK_UNITS.find(x => x.id === c.id);
    if (!u) continue;
    disks.insert(c.id, c.image, c.name);
    u.setInfo(disks.image?.(c.id) ?? null);
    u.setName(c.name);
  }
}

// ── Drives set up one at a time (ui.driveModels) ──────────────────────────

/**
 * Read the four pane slots back from the machine's drives, after the drive
 * list changed under them: each slot shows (and persists) whatever its drive
 * now holds, and a slot with no drive, or an empty one, is cleared. Without
 * this a removed drive's disk would come back on the next reload.
 */
function refreshBuiltinDrives(m: Machine): void {
  const disks = m.services.disks;
  if (!disks) return;
  DISK_UNITS.forEach((u, unit) => {
    const drive = disks.drives[unit];
    const saved = drive?.loaded ? disks.save(drive.id) : null;
    if (drive && saved) {
      u.setInfo(disks.image?.(drive.id) ?? null);
      u.setName(drive.mediaName);
      if (m.descriptor.ui.persistMedia) persistDisk(unit, saved.data, drive.mediaName, m.kind);
    } else {
      u.setInfo(null);
      u.setName('');
      u.setSide?.(0);
      clearDisk(unit, m.kind);
    }
  });
}

/** Record the machine's drive list as the user's setup for its kind. */
function saveDriveModels(m: Machine): void {
  const models = m.services.disks?.driveModels;
  if (models) settings.setDriveModelsFor(m.kind, models);
}

/** Add an empty drive below `unit`, of the same model; the drives under it
 *  move down, disks and all. */
export function addBuiltinDrive(unit: number): void {
  const m = machine;
  const disks = m?.services.disks;
  if (!m || !disks?.addDrive) return;
  if (!disks.addDrive(unit)) { setStatus('No room for another drive'); return; }
  saveDriveModels(m);
  refreshBuiltinDrives(m);
  setStatus(`Drive added below ${disks.drives[unit]?.label ?? ''}`.trim());
}

/** Remove a drive and its disk; the drives under it move up. */
export function removeBuiltinDrive(unit: number): void {
  const m = machine;
  const disks = m?.services.disks;
  if (!m || !disks?.removeDrive) return;
  const label = disks.drives[unit]?.label ?? '';
  if (!disks.removeDrive(unit)) return;
  saveDriveModels(m);
  refreshBuiltinDrives(m);
  setStatus(`Drive ${label} removed`);
}

/** Set one drive's model; its disk stays in it. */
export function setBuiltinDriveModel(unit: number, model: string): void {
  const m = machine;
  const disks = m?.services.disks;
  if (!m || !disks?.setDriveModel) return;
  disks.setDriveModel(unit, model);
  saveDriveModels(m);
  // A model that cannot keep the disk (a 1541's GCR disk in a 1581) empties its
  // drive: show that and drop the persisted copy.
  refreshBuiltinDrives(m);
}

export function ejectDisk(unit: number = 0): void {
  const disks = machine?.services.disks;
  const u = DISK_UNITS[unit];
  if (!machine || !disks || !u) return;
  disks.eject(u.id);
  clearDisk(unit, machine.kind);
  u.setInfo(null);
  u.setName('');
  u.setSide?.(0);
  if (unit === 0) setDiskInfoHtml('');
  setStatus(`Disk ${u.id.toUpperCase()}: ejected`);
  // Ejecting a real disk from drive 0 may re-expose the hidden boot disk.
  if (unit === 0 && machine.descriptor.ui.bootDisk) {
    bootDiskPhantom = false;
    void applyBootDisk();
  }
}

export function insertBlankDisk(image: DskImage, name: string, unit: number): void {
  const disks = machine?.services.disks;
  const u = DISK_UNITS[unit];
  if (!machine || !disks || !u) return;
  disks.insert(u.id, image, name);
  if (unit === 0) bootDiskPhantom = false;   // a real disk now occupies drive 0
  u.setInfo(image);
  u.setName(name);
}

// ── Hidden default boot disk ──────────────────────────────────────────────

let bootDiskPhantom = false;

/** Reset the phantom flag (a fresh FDC on the new machine). Called by lifecycle
 *  on every machine (re)build. */
export function resetBootDiskPhantom(): void { bootDiskPhantom = false; }

/** Reconcile the machine-declared boot disk with its profile and drive 0. */
export async function applyBootDisk(): Promise<void> {
  const m = machine;
  const disks = m?.services.disks;
  const request = disks?.bootDisk ?? null;
  if (!m || !disks || !m.descriptor.ui.bootDisk) { bootDiskPhantom = false; return; }
  const want = request !== null && currentDiskName() === '';
  if (want && !bootDiskPhantom) {
    const data = await romManager.fetchBootDisk(request.source, request.cacheKey);
    if (!data) return;                         // unavailable → option is a no-op
    const current = machine?.services.disks?.bootDisk ?? null;
    if (
      machine === m &&
      current?.cacheKey === request.cacheKey &&
      currentDiskName() === ''
    ) {
      try {
        disks.insert('a', current.parse(data.slice()), '');
        bootDiskPhantom = true;
      } catch {
        return;
      }
    }
  } else if (!want && bootDiskPhantom) {
    disks.eject('a');
    bootDiskPhantom = false;
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
  const source = entryForModel(m.model).bootCartridgeSource?.(m.model, m.descriptor.locale);
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
  machine?.services.disks?.setBootDiskEnabled?.(on);
  void applyBootDisk();
}

/**
 * Flip a combined "flippy" disk in drive `unit` (0 = A:, 1 = B:) to its other side.
 */
export function flipDisk(unit: number): void {
  const disks = machine?.services.disks;
  const u = DISK_UNITS[unit];
  if (!disks?.flipSide || !u) return;
  const newSide = disks.flipSide(u.id);
  if (newSide === null) return;
  u.setSide?.(newSide);
  setStatus(`Disk ${u.id.toUpperCase()}: flipped to Side ${newSide ? 'B' : 'A'}`);
}

export function saveDisk(unit: number): void {
  const disks = machine?.services.disks;
  const u = DISK_UNITS[unit];
  if (!machine || !disks || !u) return;
  const saved = disks.save(u.id);
  if (!saved) { setStatus(`No disk in drive ${u.id.toUpperCase()}:`); return; }
  // Keep the pane's mounted name (the service falls back to a generic base).
  const name = u.name();
  const base = name.replace(/\.[^.]+$/, '');
  const ext = saved.name.slice(saved.name.lastIndexOf('.'));
  downloadFile(saved.data, base ? `${base}${ext}` : saved.name);
}

export function loadDiskToUnit(data: Uint8Array, filename: string, unit: number): void {
  const disks = machine?.services.disks;
  const u = DISK_UNITS[unit];
  if (!machine || !disks || !u) { setStatus('Load a ROM first'); return; }
  const wasPaused = emulationPaused();
  machine.stop();
  try {
    const image = parseFloppyImage(data);
    disks.insert(u.id, image, filename);
    if (unit === 0) bootDiskPhantom = false;
    u.setInfo(image);
    u.setName(filename);
    if (machine.descriptor.ui.persistMedia) {
      if (unit === 0) persistLastFile(data, filename);
      persistDisk(unit, data, filename, machine.kind);
    }
    setStatus(`Disk ${u.id.toUpperCase()}: loaded: ${filename}`);
  } catch (e) {
    setStatus(`Disk error: ${(e as Error).message}`);
  } finally {
    if (!wasPaused) machine.start();
  }
}

// ── Joystick / mouse routing ────────────────────────────────────────────

export function joyPressForType(dir: string, pressed: boolean, mode: string, player = 0): void {
  machine?.services.input.joystick?.press(dir, pressed, mode, player);
}

/** The id of the captured mouse interface, from `ui.mouseTypes`, or null. */
export type MouseMode = string | null;

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
    // Instant cassette: re-mount and reflect the machine-parsed block list.
    svc.restoreStash(stash.state, stash.name);
    reflectInstantCassette(stash.state.casData, stash.name);
    setTurboMode(false);
  } else if (svc && stash?.state.blocks && stash.state.blocks.length > 0) {
    svc.restoreStash(stash.state, stash.name);
    // A model change always rewinds: the rebuilt machine boots from scratch, so
    // a tape carried across restarts at its first block rather than resuming
    // mid-load against a loader that never queued it.
    svc.seek(0);
    batch(() => {
      setTapeLoaded(true);
      setTapeName(stash.name);
      setTapeBlocks([...stash.state.blocks!]);
      setTapePosition(0);
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
  const m = machine;

  // Restore the tape persisted for THIS platform (kept isolated per machine
  // kind). The machine's TapeService parses its own formats.
  const tape = await restoreTape(machine.kind);
  const tapeSvc = machine.services.tape;
  if (tape && tapeSvc) {
    if (machine.descriptor.ui.tape === 'instant') {
      mountInstantCassette(tape.data, tape.name);
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
    for (let unit = 0; unit < (machine.descriptor.ui.builtinDrives ?? 2); unit++) {
      const u = DISK_UNITS[unit];
      if (!u) continue;
      const id = u.id;
      // A machine with a variable drive list restores only into drives it has.
      if (m.descriptor.ui.driveModels && !disks.drives.some(d => d.id === id)) continue;
      const disk = await restoreDisk(unit, m.kind);
      if (!disk) continue;
      // Re-mount through the machine's OWN media service, exactly as a fresh
      // load does. Parsing here instead meant a restore only understood the
      // formats the generic detector knows — enough for a +3 .dsk, but not for
      // a disk image that is routed by content and routinely arrives
      // gzipped or zipped inside a name that says `.dsk`. The machine is the declared
      // owner of "what is this file and which drive does it belong in", and a
      // reload has no business deciding that differently from a drag-drop.
      let result: MountResult | null = null;
      try {
        result = await m.services.media.mount(disk.data, disk.name, id);
      } catch { /* ignore corrupt data */ }
      if (machine !== m || !result?.ok || result.target !== id) continue;
      u.setInfo(disks.image?.(id) ?? null);
      u.setName(disk.name);
    }

    await restorePeripheralDrives(disks);
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
