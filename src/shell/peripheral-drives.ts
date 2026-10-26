/**
 * Shell glue for the Spectrum's add-on drives: the MGT +D and Beta Disk (two
 * WD179x drives each, shown in the pane's C:/D: slots) and the ZX Interface 1
 * microdrives. Each floppy add-on declares how its images are parsed, persisted
 * and worded once (`DiskPeripheral`); load, eject, save, restore and the blank-
 * disk inserts are shared.
 *
 * The drives belong to the machine's DiskService, addressed by `plusd:<unit>`,
 * `beta:<unit>` and `mdv:<unit>`; this module only reflects them into the panes'
 * signals and storage.
 */

import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeHFE, attachHfeBitstream } from '@/media/floppy/hfe.ts';
import { parsePlusDMedia, parseBetaMedia } from '@/media/floppy/addon-images.ts';
import { serializeMgt, blankMgtDisk } from '@/media/floppy/mgt-image.ts';
import { serializeTrd, blankTrdDisk } from '@/media/floppy/trd-image.ts';
import { serializeScl, SCL_DISK_FORMAT } from '@/media/floppy/scl-image.ts';
import { parseMdrBlocks } from '@/media/microdrive.ts';
import {
  persistPlusDDisk, restorePlusDDisk, clearPlusDDisk,
  persistBetaDiskDisk, restoreBetaDiskDisk, clearBetaDiskDisk,
  persistMicrodrive, restoreMicrodrive, clearMicrodrive,
} from '@/store/persistence.ts';
import {
  currentDiskNameC, currentDiskNameD,
  setCurrentDiskInfoC, setCurrentDiskNameC, setCurrentDiskInfoD, setCurrentDiskNameD,
} from '@/state/disk-state.ts';
import { microdriveSlots, setMicrodriveSlot, clearMicrodriveSlot } from '@/state/microdrive-state.ts';
import type { Machine } from '@/machines/machine.ts';
import { machine, setStatus } from '@/shell/context.ts';
import { autoBootLoad } from '@/shell/lifecycle.ts';
import { downloadFile } from '@/shell/download.ts';

type DiskService = NonNullable<Machine['services']['disks']>;

/** True when the active machine currently offers drive id `id`. */
function hasDrive(id: string): boolean {
  return machine?.services.disks?.drives.some(d => d.id === id) ?? false;
}

// ── Two-drive floppy add-ons (+D, Beta Disk) ──────────────────────────────

interface DiskPeripheral {
  /** The DiskService drive-id prefix: `<prefix>:<unit>`. */
  readonly prefix: 'plusd' | 'beta';
  /** Drive letters for units 0 and 1. */
  readonly letters: readonly [string, string];
  /** The add-on as named in drive messages ("No disk in +D drive C:"). */
  readonly label: string;
  /** The add-on as named in disk messages ("+D disk C: loaded"). */
  readonly diskLabel: string;
  readonly notFitted: string;
  /** Base name for a download when the mounted name has none. */
  readonly saveBase: string;
  /** Decode an image file; null when it is not one this add-on reads. */
  parse(data: Uint8Array, filename: string): DskImage | null;
  persist(unit: number, data: Uint8Array, name: string): void;
  clear(unit: number): void;
  restore(unit: number): Promise<{ data: Uint8Array; name: string } | null>;
}

const PLUSD: DiskPeripheral = {
  prefix: 'plusd',
  letters: ['C', 'D'],
  label: '+D',
  diskLabel: '+D disk',
  notFitted: 'Enable the MGT +D in Hardware first',
  saveBase: 'plusd',
  parse: (data, filename) => parsePlusDMedia(data, filename),
  persist: (unit, data, name) => persistPlusDDisk(unit, data, name),
  clear: (unit) => clearPlusDDisk(unit),
  restore: (unit) => restorePlusDDisk(unit),
};

const BETA: DiskPeripheral = {
  prefix: 'beta',
  letters: ['A', 'B'],
  label: 'Beta Disk',
  diskLabel: 'Beta Disk',
  notFitted: 'Enable the Beta Disk in Hardware first',
  saveBase: 'betadisk',
  parse: (data) => parseBetaMedia(data),
  persist: (unit, data, name) => persistBetaDiskDisk(unit, data, name),
  clear: (unit) => clearBetaDiskDisk(unit),
  restore: (unit) => restoreBetaDiskDisk(unit),
};

const driveId = (p: DiskPeripheral, unit: number) => `${p.prefix}:${unit}`;

/** Both add-ons show their two drives in the pane's C:/D: slots. */
function setPeripheralDiskState(unit: number, image: DskImage | null, name: string): void {
  if (unit === 0) { setCurrentDiskInfoC(image); setCurrentDiskNameC(name); }
  else { setCurrentDiskInfoD(image); setCurrentDiskNameD(name); }
}

/** Put a decoded image into the drive and reflect + persist it. */
function mountPeripheralImage(p: DiskPeripheral, unit: number, image: DskImage, data: Uint8Array, name: string): void {
  machine!.services.disks!.insert(driveId(p, unit), image, name);
  setPeripheralDiskState(unit, image, name);
  p.persist(unit, data, name);
}

function loadPeripheralDisk(p: DiskPeripheral, data: Uint8Array, filename: string, unit: number): void {
  if (!machine) { setStatus('Load a ROM first'); return; }
  if (!hasDrive(driveId(p, unit))) { setStatus(p.notFitted); return; }
  let image: DskImage | null;
  try {
    image = p.parse(data, filename);
  } catch (e) {
    setStatus(`${p.diskLabel} error: ${(e as Error).message}`);
    return;
  }
  if (!image) { setStatus(`Not a recognised ${p.label} image: ${filename}`); return; }
  mountPeripheralImage(p, unit, image, data, filename);
  setStatus(`${p.diskLabel} ${p.letters[unit]}: loaded: ${filename}`);
}

function ejectPeripheralDisk(p: DiskPeripheral, unit: number): void {
  if (!machine || !hasDrive(driveId(p, unit))) return;
  machine.services.disks!.eject(driveId(p, unit));
  p.clear(unit);
  setPeripheralDiskState(unit, null, '');
  setStatus(`${p.diskLabel} ${p.letters[unit]}: ejected`);
}

function savePeripheralDisk(p: DiskPeripheral, unit: number): void {
  if (!machine || !hasDrive(driveId(p, unit))) return;
  const saved = machine.services.disks!.save(driveId(p, unit));
  if (!saved) { setStatus(`No disk in ${p.label} drive ${p.letters[unit]}:`); return; }
  const name = unit === 0 ? currentDiskNameC() : currentDiskNameD();
  const base = name.replace(/\.[^.]+$/, '') || p.saveBase;
  const ext = saved.name.slice(saved.name.lastIndexOf('.'));
  downloadFile(saved.data, `${base}${ext}`);
}

/** Put back the add-on's persisted discs, when it is fitted. */
async function restorePeripheralDisks(p: DiskPeripheral, disks: DiskService): Promise<void> {
  if (!hasDrive(driveId(p, 0))) return;
  for (const unit of [0, 1]) {
    const disk = await p.restore(unit);
    if (!disk) continue;
    try {
      const image = p.parse(disk.data, disk.name);
      if (!image) continue;
      disks.insert(driveId(p, unit), image, disk.name);
      setPeripheralDiskState(unit, image, disk.name);
    } catch { /* ignore corrupt data */ }
  }
}

/** Load a .mgt/.img/.hfe image into a +D drive (unit 0/1 → C:/D:). */
export function loadPlusDDisk(data: Uint8Array, filename: string, unit: number): void {
  loadPeripheralDisk(PLUSD, data, filename, unit);
}

export function ejectPlusDDisk(unit: number): void { ejectPeripheralDisk(PLUSD, unit); }

export function savePlusDDisk(unit: number): void { savePeripheralDisk(PLUSD, unit); }

/** Blank +D geometries offered in the UI (all 10 × 512-byte sectors). */
export interface PlusDBlankGeometry { tracks: number; sides: number; }

export function insertBlankPlusDDisk(unit: number, geom: PlusDBlankGeometry, asHfe = false): void {
  if (!machine || !hasDrive(driveId(PLUSD, unit))) return;
  const base = blankMgtDisk(geom.tracks, geom.sides);
  const image = asHfe ? attachHfeBitstream(base) : base;
  const [name, data] = asHfe
    ? ['BLANK.hfe', serializeHFE(image)]
    : ['BLANK.mgt', serializeMgt(image, 'mgt')];
  mountPeripheralImage(PLUSD, unit, image, data, name);
}

/** Load a .trd/.scl/.hfe image into a Beta Disk drive (unit 0/1). */
export function loadBetaDiskDisk(data: Uint8Array, filename: string, unit: number): void {
  loadPeripheralDisk(BETA, data, filename, unit);
}

export function ejectBetaDiskDisk(unit: number): void { ejectPeripheralDisk(BETA, unit); }

export function saveBetaDiskDisk(unit: number): void { savePeripheralDisk(BETA, unit); }

/** Blank TR-DOS geometries offered in the UI (all 16 × 256-byte sectors). */
export interface BetaDiskBlankGeometry { tracks: number; sides: number; }

export function insertBlankBetaDiskDisk(unit: number, geom: BetaDiskBlankGeometry = { tracks: 80, sides: 2 }, asScl = false): void {
  if (!machine || !hasDrive(driveId(BETA, unit))) return;
  const image = asScl ? blankTrdDisk(80, 2) : blankTrdDisk(geom.tracks, geom.sides);
  if (asScl) image.diskFormat = SCL_DISK_FORMAT;
  const [name, data] = asScl ? ['BLANK.scl', serializeScl(image)] : ['BLANK.trd', serializeTrd(image)];
  mountPeripheralImage(BETA, unit, image, data, name);
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

// ── Shell hooks: reflecting a mount, and restoring after a reload ─────────

/**
 * Reflect a mount whose `target` is one of these add-on drives into the panes
 * and storage. Returns false when `target` is not an add-on drive, so the
 * caller can try its own targets.
 */
export function reflectPeripheralMount(
  m: Machine,
  target: string,
  data: Uint8Array,
  filename: string,
  autoBoot: boolean,
): boolean {
  if (target.startsWith('plusd:')) {
    const u = Number(target.slice(6));
    setPeripheralDiskState(u, m.services.disks?.image?.(target) ?? null, filename);
    persistPlusDDisk(u, data, filename);
  } else if (target.startsWith('beta:')) {
    const u = Number(target.slice(5));
    setPeripheralDiskState(u, m.services.disks?.image?.(target) ?? null, filename);
    persistBetaDiskDisk(u, data, filename);
    // Opening a TR-DOS disk runs it, as the library does: reset, enter TR-DOS
    // (RANDOMIZE USR 15616) and RUN its boot file. Drive B only swaps media.
    if (autoBoot && u === 0) autoBootLoad('trdos');
  } else if (target.startsWith('mdv:')) {
    const u = Number(target.slice(4));
    const drive = m.services.disks?.drives.find(d => d.id === target);
    setMicrodriveSlot(u, { loaded: true, name: filename, writeProtected: drive?.writeProtected ?? false, modified: false, blocks: parseMdrBlocks(data) });
    persistMicrodrive(u, data, filename).catch((e) => console.warn('persistMicrodrive failed:', e));
  } else {
    return false;
  }
  return true;
}

/** Put back whichever add-on drives are fitted, from what was persisted. */
export async function restorePeripheralDrives(disks: DiskService): Promise<void> {
  await restorePeripheralDisks(PLUSD, disks);
  await restorePeripheralDisks(BETA, disks);

  // ZX Interface 1 microdrives (drives 1-8) — only when the IF1 is fitted.
  if (!hasDrive('mdv:0')) return;
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
