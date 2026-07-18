/**
 * Shell media orchestration: the machine-agnostic half of loading and saving
 * media. Zip unwrapping, the multi-file picker, download helpers, reflecting a
 * MediaService mount into the shell's state signals + persistence, the tape
 * transport wrappers, the per-peripheral disk/microdrive/cartridge wrappers, the
 * per-kind tape stash, and the joystick/mouse routing.
 *
 * Everything "which device inside this machine" is the machine's business (its
 * MediaService); the shell only routes zips, reflects results, and persists.
 */

import { batch } from 'solid-js';
import { asCpc, asEinstein, asMsx, type MountResult } from '@/machines/machine.ts';
import type { MachineKind } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { parseCSW } from '@/media/tape/csw.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { parseFloppyImage, parseHFE, serializeHFE, isHFE, attachHfeBitstream } from '@/media/floppy/hfe.ts';
import { parseSCP, isScp } from '@/media/floppy/scp.ts';
import { parseMgt, serializeMgt, blankMgtDisk, mgtExtFromName } from '@/media/floppy/mgt-image.ts';
import { parseTrd, serializeTrd, blankTrdDisk } from '@/media/floppy/trd-image.ts';
import { parseScl, serializeScl, isScl, SCL_DISK_FORMAT } from '@/media/floppy/scl-image.ts';
import { unzip } from '@/media/zip.ts';
import { showFilePicker } from '@/ui/zip-picker.ts';
import { parseCasBlocks } from '@/machines/msx/msx-tape.ts';
import * as settings from '@/store/settings.ts';
import {
  persistLastFile, persistTape, clearTape, restoreTape, persistDisk, restoreDisk, clearDisk,
  persistPlusDDisk, restorePlusDDisk, clearPlusDDisk,
  persistBetaDiskDisk, restoreBetaDiskDisk, clearBetaDiskDisk,
  persistMicrodrive, restoreMicrodrive, clearMicrodrive,
} from '@/store/persistence.ts';
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
import { machine, spectrum, romData, setStatus, romManager } from '@/shell/context.ts';
import { unpause } from '@/shell/lifecycle.ts';

// ── MSX cartridge / cassette ──────────────────────────────────────────────

/** Reflect a mounted MSX `.cas` cassette into the tape-pane signals + storage. */
function reflectMsxCassette(data: Uint8Array, name: string): void {
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
  // Persist under the MSX platform key so a reload restores it (not a ZX tape).
  persistTape('msx', data, name);
}

/** Mount an MSX `.cas` cassette and reflect it in the tape-pane signals. The
 *  cassette is served instantly through the BIOS load traps on CLOAD/BLOAD. */
export function mountMsxCassette(data: Uint8Array, name: string): void {
  const tape = asMsx(machine)?.services.tape;
  if (!tape) { setStatus('Cassettes are for the MSX'); return; }
  tape.mount(data, name);
  reflectMsxCassette(data, name);
}

/** Insert an MSX cartridge and reboot so the BIOS slot scan auto-runs it. */
export function insertMsxCartridge(data: Uint8Array, name: string): void {
  const slot = asMsx(machine)?.services.roms.cartridge;
  if (!slot) { setStatus('Cartridges are for the MSX'); return; }
  slot.insert(data, name);   // power-cycles the machine (stop → insert → reset)
  setCartridgeNameSig(name);
  setStatus(`Cartridge: ${name}`);
  if (romData) machine!.start();
}

/** Remove the MSX cartridge and reboot to BASIC. */
export function ejectMsxCartridge(): void {
  const slot = asMsx(machine)?.services.roms.cartridge;
  if (!slot) return;
  slot.eject();   // power-cycles the machine (stop → eject → reset)
  setCartridgeNameSig('');
  setStatus('Cartridge ejected');
  if (romData) machine!.start();
}

/** Insert a ZX Interface 2 ROM cartridge (16K/48K only) and reboot into it. */
export function insertIf2Cartridge(data: Uint8Array, name: string): void {
  const slot = spectrum?.services.roms.cartridge;
  if (!slot) {
    setStatus('Cartridges need a 16K/48K Spectrum');
    return;
  }
  slot.insert(data, name);
  setCartridgeNameSig(name);
  setStatus(`Cartridge: ${name}`);
  if (romData) spectrum!.start();
}

/** Remove the Interface 2 cartridge and reboot to the system ROM. */
export function ejectIf2Cartridge(): void {
  const slot = spectrum?.services.roms.cartridge;
  if (!slot) return;
  slot.eject();
  setCartridgeNameSig('');
  setStatus('Cartridge ejected');
  if (romData) spectrum!.start();
}

/** Eject whichever cartridge slot is active (MSX or ZX Interface 2). */
export function ejectCartridge(): void {
  if (asMsx(machine)) { ejectMsxCartridge(); return; }
  ejectIf2Cartridge();
}

// ── Tape / disk loading ────────────────────────────────────────────────────

export async function applyTape(data: Uint8Array, filename: string): Promise<void> {
  if (!machine) { setStatus('Load a ROM first'); return; }
  const result = await machine.services!.media.mount(data, filename);
  await reflectMount(result, data, filename);
}

/**
 * File extensions the current machine can load, for the Load picker filter.
 */
export function loadableExtensions(): string[] {
  const cpc = asCpc(machine);
  if (cpc) {
    const exts = ['.sna', '.cdt'];
    if (cpc.config.hasFDC) exts.push('.dsk', '.hfe');
    return exts;
  }
  const ein = asEinstein(machine);
  if (ein) {
    // Einstein disks are Extended CPC DSK images read by the WD1770.
    return ein.config.hasFDC ? ['.dsk', '.hfe', '.scp', '.zip'] : [];
  }
  // MSX: cartridge ROMs and cassette images (a .zip may wrap one).
  if (asMsx(machine)) return ['.rom', '.cas', '.zip'];
  // Spectrum: the machine's MediaService declares its loadable set; the shell
  // appends .zip (archives are unwrapped shell-side).
  if (spectrum) return [...spectrum.services.media.accepts().map(t => t.ext), '.zip'];
  // No-machine default (same list a Spectrum without FDC/IF1/IF2 offers).
  return ['.sna', '.z80', '.szx', '.sp', '.tap', '.tzx', '.csw', '.zip'];
}

export async function loadFile(data: Uint8Array, filename: string, unit?: number): Promise<void> {
  if (!machine) { setStatus('Load a ROM first'); return; }
  // ZIP archives are a machine-agnostic shell concern: unwrap, pick, re-dispatch.
  if (/\.zip$/i.test(filename)) {
    await handleZip(data, unit);
    return;
  }
  // Everything else routes through the active machine's own MediaService.
  const result = await machine.services!.media.mount(data, filename, unit !== undefined ? `unit:${unit}` : undefined);
  await reflectMount(result, data, filename, unit);
}

/**
 * Reflect a MediaService mount into the shell's signals / persistence / status.
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
  if (spectrum) { await reflectSpectrumMount(result, data, filename, unit); return; }
  if (!result.ok || !machine) { setStatus(result.message); return; }
  const target = result.target ?? '';
  if (target === 'tape') {
    batch(() => {
      setTapeLoaded(true);
      setTapeName(filename);
      setTapeBlocks([...machine!.tape.blocks]);
      setTapePosition(0);
      setTapePaused(true);
      setTapePlaying(true);
    });
    unpause();
    persistLastFile(data, filename);
    persistTape(machine.kind, data, filename);
  } else if (target === 'a' || target === 'b') {
    const u = target === 'a' ? 0 : 1;
    const image = machine.fdc.getDiskImage(u);
    if (u === 0) {
      // A real disk in Einstein drive 0 supersedes the phantom Xtal DOS disk.
      if (asEinstein(machine)) einsteinXtalDosPhantom = false;
      setCurrentDiskInfo(image); setCurrentDiskName(filename);
    } else {
      setCurrentDiskInfoB(image); setCurrentDiskNameB(filename);
    }
    // CPC/Einstein disks are session-only (the old cascade never persisted them).
  } else if (target === 'cas') {
    reflectMsxCassette(data, filename);
  } else if (target === 'cartridge') {
    setCartridgeNameSig(filename);
    if (romData) machine.start();
  }
  setStatus(result.message);
}

/** Unwrap a .zip and re-dispatch its (relevant) contents through loadFile. */
async function handleZip(data: Uint8Array, unit?: number): Promise<void> {
  if (!machine) return;
  if (spectrum) { await handleSpectrumZip(data, unit); return; }
  if (asCpc(machine)) { setStatus('CPC accepts .sna, .dsk, .hfe, .scp, .cdt, .tzx and .tap files'); return; }
  const ein = asEinstein(machine);
  const filter = ein ? /\.(dsk|hfe|scp)$/i : /\.(rom|cas)$/i;
  const emptyMsg = ein ? 'ZIP has no disk image (.dsk/.hfe/.scp)' : 'ZIP has no MSX image (.rom/.cas)';
  let entries;
  try { entries = await unzip(data); } catch (e) { setStatus(`ZIP error: ${(e as Error).message}`); return; }
  const media = entries.filter(e => filter.test(e.name));
  if (media.length === 0) { setStatus(emptyMsg); return; }
  let picked = media[0];
  if (media.length > 1) {
    const name = await showFilePicker(media.map(m => m.name));
    if (!name) { setStatus('No file selected'); return; }
    picked = media.find(m => m.name === name)!;
  }
  await loadFile(picked.data, picked.name, unit);   // re-dispatch the extracted image
}

/** Unwrap a .zip for the Spectrum and re-dispatch through loadFile. */
async function handleSpectrumZip(data: Uint8Array, unit?: number): Promise<void> {
  let entries;
  try {
    entries = await unzip(data);
  } catch (e) {
    setStatus(`ZIP error: ${(e as Error).message}`);
    return;
  }
  if (entries.length === 0) { setStatus('ZIP is empty'); return; }
  if (entries.length === 1) {
    await loadFile(entries[0].data, entries[0].name, unit);
    return;
  }
  const pickedName = await showFilePicker(entries.map(e => e.name));
  if (!pickedName) { setStatus('No file selected'); return; }
  const picked = entries.find(e => e.name === pickedName)!;
  await loadFile(picked.data, picked.name, unit);
}

/** Shell reflection after a Spectrum MediaService mount. */
async function reflectSpectrumMount(
  result: MountResult,
  data: Uint8Array,
  filename: string,
  unit?: number,
): Promise<void> {
  if (result.replay) {
    await loadFile(data, filename, unit);
    return;
  }
  if (!result.ok || !spectrum) {
    setStatus(result.message);
    return;
  }
  const target = result.target ?? '';
  if (target === 'tape') {
    batch(() => {
      setTapeLoaded(true);
      setTapeName(filename);
      setTapeBlocks([...spectrum!.tape.blocks]);
      setTapePosition(0);
      setTapePaused(true);
      setTapePlaying(true);
    });
    unpause();
    persistLastFile(data, filename);
    persistTape('spectrum', data, filename);
  } else if (target === 'a' || target === 'b') {
    const u = target === 'a' ? 0 : 1;
    const image = spectrum.fdc.getDiskImage(u);
    if (u === 0) { setCurrentDiskInfo(image); setCurrentDiskName(filename); }
    else { setCurrentDiskInfoB(image); setCurrentDiskNameB(filename); }
    if (u === 0) persistLastFile(data, filename);
    persistDisk(u, data, filename);
  } else if (target.startsWith('plusd:')) {
    const u = Number(target.slice(6));
    setPlusDDiskState(u, spectrum.mgtPlusD.fdc.getDiskImage(u), filename);
    persistPlusDDisk(u, data, filename);
  } else if (target.startsWith('beta:')) {
    const u = Number(target.slice(5));
    setPlusDDiskState(u, spectrum.betaDisk.fdc.getDiskImage(u), filename);
    persistBetaDiskDisk(u, data, filename);
  } else if (target.startsWith('mdv:')) {
    const u = Number(target.slice(4));
    const drive = spectrum.interface1.drives[u];
    setMicrodriveSlot(u, { loaded: true, name: filename, writeProtected: drive.writeProtected, modified: false });
    persistMicrodrive(u, data, filename).catch((e) => console.warn('persistMicrodrive failed:', e));
  } else if (target === 'cartridge') {
    setCartridgeNameSig(filename);
    if (romData) spectrum.start();
  } else if (target === 'snapshot') {
    persistLastFile(data, filename);
    unpause();
  }
  setStatus(result.message);
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

/** Save the running CPC as a `.SNA` (v2 = flat, v3 = RLE-compressed). */
export function saveCpcSnapshot(version: 2 | 3): void {
  const cpc = asCpc(machine);
  if (!cpc) { setStatus('No CPC running'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) cpc.stop();

  const data = cpc.services.snapshots.saveSna(version);
  downloadFile(data, `zx84-${cpc.model}.sna`);

  if (!wasPaused) cpc.start();
  setStatus(`Saved zx84-${cpc.model}.sna (v${version})`);
}

export async function saveSnapshot(format: 'z80' | 'szx' = 'szx'): Promise<void> {
  if (!spectrum) { setStatus('No machine running'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) spectrum.stop();

  const model = currentModel() as SpectrumModel;
  const data = await spectrum.services.snapshots.save(format);

  const filename = `zx84-${model.replace('+', 'plus')}.${format}`;

  downloadFile(data, filename);

  if (!wasPaused) spectrum.start();
  setStatus(`Saved ${filename}`);
}

export function saveScreenshot(format: 'png' | 'scr'): void {
  if (!machine) { setStatus('No machine running'); return; }

  if (format === 'scr') {
    if (spectrum) {
      const screenData = spectrum.memory.getRamBank(5).slice(0, 6912);
      downloadFile(screenData, 'screen.scr');
      setStatus('Saved screen.scr');
      return;
    }

    const cpc = asCpc(machine);
    if (cpc) {
      const quadrant = cpc.crtc.displayStart >>> 12;
      const screenData = cpc.memory.getRamBank(quadrant).slice();
      downloadFile(screenData, 'screen.scr');
      setStatus('Saved screen.scr');
      return;
    }

    // Einstein / MSX share the TMS9918A VDP — its 16KB VRAM *is* the screen.
    const vdpMachine = asEinstein(machine) ?? asMsx(machine);
    if (vdpMachine) {
      downloadFile(vdpMachine.vdp.vram.slice(), 'screen.scr');
      setStatus('Saved screen.scr');
      return;
    }

    setStatus('.scr not supported for this machine');
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

  let data: Uint8Array;
  let filename: string;

  if (spectrum) {
    const mem = spectrum.memory;
    const startAddr = mem.specialPaging ? 0 : 0x4000;
    data = mem.readBlock(startAddr, 0x10000 - startAddr);
    filename = startAddr === 0 ? 'ram-64k.bin' : 'ram-48k.bin';
  } else {
    const banked = asCpc(machine) ?? asEinstein(machine) ?? asMsx(machine);
    if (!banked) { setStatus('RAM save not supported for this machine'); return; }
    data = banked.memory.ramSnapshot();
    filename = 'ram-64k.bin';
  }

  const wasPaused = emulationPaused();
  if (!wasPaused) machine.stop();
  downloadFile(data, filename);
  if (!wasPaused) machine.start();
  setStatus(`Saved ${filename}`);
}

// ── Tape transport ──────────────────────────────────────────────────────

export function tapeRewind(): void {
  if (!machine) return;
  if (spectrum) spectrum.services.tape.rewind();
  else machine.tape.rewind();
  setTapePosition(0);
}

export function tapePrev(): void {
  if (!machine) return;
  const pos = machine.tape.position;
  if (pos > 0) {
    if (spectrum) spectrum.services.tape.seek(pos - 1);
    else machine.tape.position = pos - 1;
  }
  setTapePosition(machine.tape.position);
}

export function tapeTogglePlay(): void {
  if (!machine) return;
  if (spectrum) {
    const svc = spectrum.services.tape;
    if (svc.playing) {
      svc.stop();
      setTapePlaying(false);
    } else {
      svc.play();
      setTapePaused(false);
      setTapePlaying(true);
    }
    return;
  }
  if (machine.tape.playing) {
    machine.tape.stopPlayback();
    setTapePlaying(false);
  } else {
    machine.tape.paused = false;
    machine.tape.startPlayback();
    setTapePaused(false);
    setTapePlaying(true);
  }
}

export function tapeTogglePause(): void {
  if (!machine) return;
  if (spectrum) {
    const svc = spectrum.services.tape;
    if (svc.paused) svc.resume();
    else svc.pause();
    setTapePaused(svc.paused);
    return;
  }
  machine.tape.paused = !machine.tape.paused;
  setTapePaused(machine.tape.paused);
}

export function tapeNext(): void {
  if (!machine) return;
  const pos = machine.tape.position;
  if (pos < machine.tape.blocks.length) {
    if (spectrum) spectrum.services.tape.seek(pos + 1);
    else machine.tape.position = pos + 1;
  }
  setTapePosition(machine.tape.position);
}

export function tapeSetPosition(pos: number): void {
  if (!machine) return;
  if (spectrum) spectrum.services.tape.seek(pos);
  else machine.tape.position = pos;
  setTapePosition(pos);
}

export function toggleAutoRewind(): void {
  settings.setTapeAutoRewind(!settings.tapeAutoRewind());
  settings.persistSetting('tape-auto-rewind', settings.tapeAutoRewind() ? 'on' : 'off');
}

export function ejectTape(): void {
  if (!machine) return;
  const msx = asMsx(machine);
  const clearSignals = () => batch(() => {
    setTapeLoaded(false);
    setTapeName('');
    setTapeBlocks([]);
    setCasBlocks([]);
    setCasPosition(-1);
    setTapePosition(0);
    setTapePaused(true);
    setTapePlaying(false);
  });
  const tape = machine.services!.tape;
  if (tape) {
    tape.eject();
  } else {
    // The Einstein deck is inert (no TapeService); reset it directly.
    machine.tape.stopPlayback();
    machine.tape.blocks = [];
    machine.tape.position = 0;
    machine.tape.paused = true;
  }
  clearSignals();
  clearTape(machine.kind);
  setStatus(msx ? 'Cassette ejected' : 'Tape ejected');
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

// ── Disk transport ──────────────────────────────────────────────────────

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
    spectrum.services.disks.eject(unit === 0 ? 'a' : 'b');
    clearDisk(unit);
    onEjected(unit);
    setStatus(`Disk ${unit === 0 ? 'A' : 'B'}: ejected`);
  } else {
    machine.fdc.ejectDisk(unit);
    clearDisk(unit);
    onEjected(unit);
    setStatus(`Disk ${unit === 0 ? 'A' : 'B'}: ejected`);
    // Ejecting a real disk from Einstein drive 0 may re-expose the phantom disk.
    if (unit === 0) { einsteinXtalDosPhantom = false; applyEinsteinXtalDosDisk(); }
  }
}

export function insertBlankDisk(image: DskImage, name: string, unit: number): void {
  if (!machine) return;
  machine.fdc.insertDisk(image, unit);
  if (unit === 0) {
    einsteinXtalDosPhantom = false;   // a real disk now occupies drive 0
    setCurrentDiskInfo(image);
    setCurrentDiskName(name);
  } else {
    setCurrentDiskInfoB(image);
    setCurrentDiskNameB(name);
  }
}

// ── Einstein "Xtal DOS" auto-boot disk ────────────────────────────────────

let einsteinXtalDosImage: DskImage | null = null;
let einsteinXtalDosPhantom = false;

/** Reset the phantom flag (a fresh FDC on the new machine). Called by lifecycle
 *  on every machine (re)build. */
export function resetEinsteinPhantom(): void { einsteinXtalDosPhantom = false; }

/** Reconcile the phantom Xtal DOS disk with the current option + drive-0 state. */
export async function applyEinsteinXtalDosDisk(): Promise<void> {
  const ein = asEinstein(machine);
  if (!ein) { einsteinXtalDosPhantom = false; return; }
  const want = settings.einsteinXtalDos() && currentDiskName() === '';
  if (want && !einsteinXtalDosPhantom) {
    if (!einsteinXtalDosImage) {
      const data = await romManager.fetchEinsteinXtalDosDisk();
      if (!data) return;                       // unavailable → option is a no-op
      try { einsteinXtalDosImage = parseFloppyImage(data); } catch { return; }
    }
    if (asEinstein(machine) === ein && settings.einsteinXtalDos() && currentDiskName() === '') {
      ein.fdc.insertDisk(einsteinXtalDosImage, 0);
      einsteinXtalDosPhantom = true;
    }
  } else if (!want && einsteinXtalDosPhantom) {
    ein.fdc.ejectDisk(0);
    einsteinXtalDosPhantom = false;
  }
}

/** Toggle the Einstein "Xtal DOS" hardware option and apply it immediately. */
export function setEinsteinXtalDosEnabled(on: boolean): void {
  settings.setEinsteinXtalDos(on);
  settings.persistSetting('einstein-xtaldos', on ? 'on' : 'off');
  applyEinsteinXtalDosDisk();
}

/**
 * Flip a combined "flippy" disk in drive `unit` (0 = A:, 1 = B:) to its other side.
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
  const base = name.replace(/\.[^.]+$/, '');
  const [data, filename] = image.bitstream
    ? [serializeHFE(image), `${base}.hfe`]
    : [serializeDSK(image), `${base}.dsk`];
  downloadFile(data, filename);
  machine.fdc.clearDirty(unit);   // the on-disk file now matches the image
}

export function loadDiskToUnit(data: Uint8Array, filename: string, unit: number): void {
  if (!machine) { setStatus('Load a ROM first'); return; }
  const id = unit === 0 ? 'a' : 'b';
  const onDiskLoaded = (image: DskImage) => {
    if (unit === 0) { setCurrentDiskInfo(image); setCurrentDiskName(filename); }
    else { setCurrentDiskInfoB(image); setCurrentDiskNameB(filename); }
  };
  const cpc = asCpc(machine);
  const ein = asEinstein(machine);
  if (cpc || ein) {
    try {
      const image = parseFloppyImage(data);
      machine.services!.disks!.insert(id, image, filename);
      if (ein && unit === 0) einsteinXtalDosPhantom = false;
      onDiskLoaded(image);
      setStatus(`Disk ${unit === 0 ? 'A' : 'B'}: loaded: ${filename}`);
    } catch (e) {
      setStatus(`Disk error: ${(e as Error).message}`);
    }
    return;
  }
  if (!spectrum) { setStatus('Load a ROM first'); return; }
  spectrum.stop();
  try {
    const image = parseFloppyImage(data);
    onDiskLoaded(image);
    spectrum.services.disks.insert(id, image, filename);
    if (unit === 0) persistLastFile(data, filename);
    persistDisk(unit, data, filename);
    setStatus(`Disk ${unit === 0 ? 'A' : 'B'}: loaded: ${filename}`);
  } catch (e) {
    setStatus(`DSK error: ${(e as Error).message}`);
  } finally {
    spectrum.start();
  }
}

// ── MGT +D disk helpers (drives C/D = WD1772 units 0/1) ──────────────────

function setPlusDDiskState(unit: number, image: DskImage | null, name: string): void {
  if (unit === 0) { setCurrentDiskInfoC(image); setCurrentDiskNameC(name); }
  else { setCurrentDiskInfoD(image); setCurrentDiskNameD(name); }
}

/** Load a .mgt/.img/.hfe image into a +D drive (unit 0/1 → C:/D:). */
export function loadPlusDDisk(data: Uint8Array, filename: string, unit: number): void {
  if (!spectrum) { setStatus('Load a ROM first'); return; }
  if (!spectrum.mgtPlusD.enabled) { setStatus('Enable the MGT +D in Hardware first'); return; }
  let image: DskImage | null;
  try {
    image = isHFE(data) ? parseHFE(data) : isScp(data) ? parseSCP(data) : parseMgt(data, mgtExtFromName(filename));
  } catch (e) {
    setStatus(`+D disk error: ${(e as Error).message}`);
    return;
  }
  if (!image) { setStatus(`Not a recognised +D image: ${filename}`); return; }
  spectrum.stop();
  try {
    spectrum.loadPlusDDisk(image, unit);
    setPlusDDiskState(unit, image, filename);
    persistPlusDDisk(unit, data, filename);
    setStatus(`+D disk ${unit === 0 ? 'C' : 'D'}: loaded: ${filename}`);
  } finally {
    spectrum.start();
  }
}

export function ejectPlusDDisk(unit: number): void {
  if (!spectrum) return;
  spectrum.mgtPlusD.fdc.ejectDisk(unit);
  clearPlusDDisk(unit);
  setPlusDDiskState(unit, null, '');
  setStatus(`+D disk ${unit === 0 ? 'C' : 'D'}: ejected`);
}

/** Blank +D geometries offered in the UI (all 10 × 512-byte sectors). */
export interface PlusDBlankGeometry { tracks: number; sides: number; }

export function insertBlankPlusDDisk(unit: number, geom: PlusDBlankGeometry, asHfe = false): void {
  if (!spectrum) return;
  const base = blankMgtDisk(geom.tracks, geom.sides);
  const image = asHfe ? attachHfeBitstream(base) : base;
  spectrum.loadPlusDDisk(image, unit);
  const [name, data] = asHfe
    ? ['BLANK.hfe', serializeHFE(image)]
    : ['BLANK.mgt', serializeMgt(image, 'mgt')];
  setPlusDDiskState(unit, image, name);
  persistPlusDDisk(unit, data, name);
}

export function savePlusDDisk(unit: number): void {
  if (!spectrum) return;
  const image = spectrum.mgtPlusD.fdc.getDiskImage(unit);
  if (!image) { setStatus(`No disk in +D drive ${unit === 0 ? 'C' : 'D'}:`); return; }
  const name = unit === 0 ? currentDiskNameC() : currentDiskNameD();
  const base = name.replace(/\.[^.]+$/, '') || 'plusd';
  const [data, filename] = image.bitstream
    ? [serializeHFE(image), `${base}.hfe`]
    : [serializeMgt(image, 'mgt'), `${base}.mgt`];
  downloadFile(data, filename);
  spectrum.mgtPlusD.fdc.clearDirty(unit);
}

// ── Beta Disk (TR-DOS) helpers (WD1793 units 0/1) ────────────────────────

/** Load a .trd/.scl/.hfe image into a Beta Disk drive (unit 0/1). */
export function loadBetaDiskDisk(data: Uint8Array, filename: string, unit: number): void {
  if (!spectrum) { setStatus('Load a ROM first'); return; }
  if (!spectrum.betaDisk.enabled) { setStatus('Enable the Beta Disk in Hardware first'); return; }
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
  spectrum.stop();
  try {
    spectrum.loadBetaDiskDisk(image, unit);
    setPlusDDiskState(unit, image, filename);
    persistBetaDiskDisk(unit, data, filename);
    setStatus(`Beta Disk ${unit === 0 ? 'A' : 'B'}: loaded: ${filename}`);
  } finally {
    spectrum.start();
  }
}

export function ejectBetaDiskDisk(unit: number): void {
  if (!spectrum) return;
  spectrum.betaDisk.fdc.ejectDisk(unit);
  clearBetaDiskDisk(unit);
  setPlusDDiskState(unit, null, '');
  setStatus(`Beta Disk ${unit === 0 ? 'A' : 'B'}: ejected`);
}

/** Blank TR-DOS geometries offered in the UI (all 16 × 256-byte sectors). */
export interface BetaDiskBlankGeometry { tracks: number; sides: number; }

export function insertBlankBetaDiskDisk(unit: number, geom: BetaDiskBlankGeometry = { tracks: 80, sides: 2 }, asScl = false): void {
  if (!spectrum) return;
  const image = asScl ? blankTrdDisk(80, 2) : blankTrdDisk(geom.tracks, geom.sides);
  if (asScl) image.diskFormat = SCL_DISK_FORMAT;
  spectrum.loadBetaDiskDisk(image, unit);
  const [name, data] = asScl ? ['BLANK.scl', serializeScl(image)] : ['BLANK.trd', serializeTrd(image)];
  setPlusDDiskState(unit, image, name);
  persistBetaDiskDisk(unit, data, name);
}

export function saveBetaDiskDisk(unit: number): void {
  if (!spectrum) return;
  const image = spectrum.betaDisk.fdc.getDiskImage(unit);
  if (!image) { setStatus(`No disk in Beta Disk drive ${unit === 0 ? 'A' : 'B'}:`); return; }
  const name = unit === 0 ? currentDiskNameC() : currentDiskNameD();
  const base = name.replace(/\.[^.]+$/, '') || 'betadisk';
  const [data, filename] = image.bitstream
    ? [serializeHFE(image), `${base}.hfe`]
    : image.diskFormat === SCL_DISK_FORMAT
    ? [serializeScl(image), `${base}.scl`]
    : [serializeTrd(image), `${base}.trd`];
  downloadFile(data, filename);
  spectrum.betaDisk.fdc.clearDirty(unit);
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
  clearMicrodrive(unit);
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

export { KEMPSTON_BITS, CURSOR_KEYS, SINCLAIR1_KEYS, SINCLAIR2_KEYS, resetJoystickKeyState } from '@/machines/spectrum/peripherals/joysticks.ts';
import { joyPressForType as _joyPress } from '@/machines/spectrum/peripherals/joysticks.ts';

export function joyPressForType(dir: string, pressed: boolean, mode: string, player = 0): void {
  const msx = asMsx(machine);
  if (msx) {
    msx.joystick.set(dir, pressed, player);
    return;
  }
  const cpc = asCpc(machine);
  if (cpc) {
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

/** The active machine's two mice (both machines expose the same pair), or null. */
function activeMice() {
  if (spectrum) return { kempston: spectrum.kempstonMouse, amx: spectrum.amxMouse };
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

// ── Multiface (live enable + NMI) ──────────────────────────────────────

/** Enable/disable the CPC Multiface live (no machine rebuild). */
export function setCpcMultiface(on: boolean): void {
  const cpc = asCpc(machine);
  if (!cpc) return;
  cpc.multiface.enabled = on;
  if (on) {
    cpc.seedMultifaceShadow();
    if (!cpc.multiface.romLoaded) {
      // Fire-and-forget: the ROM is paged only on the button press.
      void fulfillAuxRoms([cpc.multifaceAuxRom(false)]);
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

// ── Per-kind tape stash (family-independent decks) ─────────────────────────

/** A loaded tape parked while another machine family is active. Decks are kept
 *  independent per platform *kind* (spectrum / cpc / einstein / msx): switching
 *  across incompatible families stashes the outgoing tape under its own kind and
 *  restores the incoming kind's own tape (if any), so one system's tape never
 *  turns up on another. Same-family switches round-trip through the same stash.
 *  Spectrum/CPC/Einstein use the pulse-level TapeDeck (blocks); the MSX uses its
 *  instant-load cassette (raw .cas bytes). */
interface TapeStash {
  name: string;
  blocks?: TapeBlock[];
  position?: number;
  paused?: boolean;
  casData?: Uint8Array;
}
const tapeStashes: Partial<Record<MachineKind, TapeStash>> = {};

/** Stash the outgoing machine's tape under its own platform kind. */
export function stashOutgoingTape(m: import('@/machines/machine.ts').Machine): void {
  const outMsx = asMsx(m);
  if (outMsx) {
    tapeStashes.msx = outMsx.cassette.loaded
      ? { name: outMsx.cassette.name, casData: outMsx.cassette.getData() }
      : undefined;
  } else {
    tapeStashes[m.kind] = {
      blocks: [...m.tape.blocks],
      position: m.tape.position,
      paused: m.tape.paused,
      name: tapeName(),
    };
  }
}

/** Restore the tape stashed for the NEW machine's platform kind (if any). */
export function restoreTapeForMachine(m: import('@/machines/machine.ts').Machine): void {
  const stash = tapeStashes[m.kind];
  const restoreMsx = asMsx(m);
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
  if (restoreMsx && stash?.casData) {
    mountMsxCassette(stash.casData, stash.name);   // remounts + parses the .cas blocks
    setTurboMode(false);
  } else if (!restoreMsx && stash?.blocks && stash.blocks.length > 0) {
    m.tape.blocks = stash.blocks;
    m.tape.position = stash.position ?? 0;
    m.tape.paused = stash.paused ?? true;
    batch(() => {
      setTapeLoaded(true);
      setTapeName(stash.name);
      setTapeBlocks([...stash.blocks!]);
      setTapePosition(stash.position ?? 0);
      setTapePaused(stash.paused ?? true);
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

  // Restore the tape persisted for THIS platform (kept isolated per machine kind).
  const tape = await restoreTape(machine.kind);
  if (tape) {
    try {
      if (asMsx(machine)) {
        mountMsxCassette(tape.data, tape.name);   // .cas → instant-load cassette
      } else {
        const ext = tape.name.toLowerCase().split('.').pop();
        const blocks = ext === 'tzx' || ext === 'cdt'
          ? parseTZX(tape.data)
          : ext === 'csw'
          ? await parseCSW(tape.data)
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
      }
    } catch { /* ignore corrupt data */ }
  }

  // Restore disks (CPC and Spectrum +3 both drive the shared uPD765A)
  const diskA = await restoreDisk(0);
  if (diskA) {
    try {
      const image = parseFloppyImage(diskA.data);
      machine.loadDisk(image, 0);
      setCurrentDiskInfo(image);
      setCurrentDiskName(diskA.name);
    } catch { /* ignore corrupt data */ }
  }

  const diskB = await restoreDisk(1);
  if (diskB) {
    try {
      const image = parseFloppyImage(diskB.data);
      machine.loadDisk(image, 1);
      setCurrentDiskInfoB(image);
      setCurrentDiskNameB(diskB.name);
    } catch { /* ignore corrupt data */ }
  }

  // MGT +D drives C:/D: — only when the +D is fitted.
  if (spectrum?.mgtPlusD.enabled) {
    for (const unit of [0, 1]) {
      const disk = await restorePlusDDisk(unit);
      if (!disk) continue;
      try {
        const image = isHFE(disk.data) ? parseHFE(disk.data)
          : isScp(disk.data) ? parseSCP(disk.data)
          : parseMgt(disk.data, mgtExtFromName(disk.name));
        if (!image) continue;
        spectrum.loadPlusDDisk(image, unit);
        setPlusDDiskState(unit, image, disk.name);
      } catch { /* ignore corrupt data */ }
    }
  }

  // Beta Disk drives A:/B: — only when the Beta Disk is fitted.
  if (spectrum?.betaDisk.enabled) {
    for (const unit of [0, 1]) {
      const disk = await restoreBetaDiskDisk(unit);
      if (!disk) continue;
      try {
        const image = isHFE(disk.data) ? parseHFE(disk.data)
          : isScp(disk.data) ? parseSCP(disk.data)
          : isScl(disk.data) ? parseScl(disk.data)
          : parseTrd(disk.data);
        if (!image) continue;
        spectrum.loadBetaDiskDisk(image, unit);
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

import type { SpectrumModel } from '@/models.ts';
import { fulfillAuxRoms } from '@/shell/rom.ts';
