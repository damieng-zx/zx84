/**
 * Atari disk service: one to four drives (D1: onward) addressed by SIO, each
 * of its own model (810, 1050, XF551 or SIO2PC; see drive-models.ts) as the
 * Drives pane chooses. The model decides which disk densities a drive reads
 * and how it reports itself, so drives of different models can share the bus.
 *
 * A drive's id ('a'-'d'), label and SIO device number follow its position, so
 * removing a drive moves the ones below it up (disk and model with them) and
 * adding one pushes them down.
 *
 * The drives are sector devices: the SIO READ/WRITE commands carry a linear
 * 1-based sector number, so there is no CHRN track addressing to expose. The
 * generic Drive pane still wants a `DskImage`, which `AtariDisk.toDskImage`
 * synthesises by grouping sectors into 18/26-sector tracks.
 *
 * Disk images are ATR or raw XFD (the codec lives in `media/floppy/atr.ts`).
 * The service accepts either the original bytes or a `DskImage` carried across
 * a model switch, converting the latter back into an ATR.
 */

import type {
  DiskService, DriveDescriptor, DriveMedia,
} from '@/machines/machine.ts';
import { baseName } from '@/machines/shared/disk-save.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { atrFromDskImage, parseAtariDisk, type AtariDisk } from '@/media/floppy/atr.ts';
import {
  ATARI_MAX_DRIVES, DEFAULT_DRIVE_MODEL, driveReads, normalizeDriveModels, percomBlock, percomStatusBits,
  type AtariDriveModel,
} from '../drive-models.ts';

export interface AtariDriveState {
  /** Position-derived: 'a' for D1:, 'b' for D2:, and so on. */
  id: string;
  label: string;
  /** SIO device id: $31 for D1:, $32 for D2:. */
  device: number;
  /** The drive's own model. */
  model: AtariDriveModel;
  disk: AtariDisk | null;
  name: string;
  writeProtected: boolean;
  /** Motor is on for this SIO access (the probe clears it). */
  motorOn: boolean;
  /** 0 idle, 1 motor, 2 read, 3 write — the Drive-pane LED code. */
  activity: 0 | 1 | 2 | 3;
  dirty: boolean;
  /** Last sector addressed, for the pane (1-based track/sector). */
  track: number;
  sector: number;
  /** The configuration block a program wrote with WRITE PERCOM, which the
   *  drive then reports and shows in its status; null until one does, and
   *  again when the disk changes. */
  percom: Uint8Array | null;
  /** The last read or write failed (status bit 2), until one succeeds. */
  lastOpFailed: boolean;
}

function isDskImage(media: DriveMedia): media is DskImage {
  return typeof media === 'object' && media !== null && 'tracks' in media;
}

function newDrive(model: AtariDriveModel): AtariDriveState {
  return {
    id: '', label: '', device: 0, model, disk: null, name: '',
    writeProtected: false, motorOn: false, activity: 0, dirty: false, track: 0, sector: 0,
    percom: null, lastOpFailed: false,
  };
}

export class AtariDiskService implements DiskService {
  /** The fitted drives, D1: first. */
  readonly states: AtariDriveState[] = [];

  constructor(models: readonly AtariDriveModel[] = normalizeDriveModels(null)) {
    for (const model of models) this.states.push(newDrive(model));
    this.renumber();
  }

  /** The models of the fitted drives, in order. */
  get driveModels(): readonly AtariDriveModel[] {
    return this.states.map(s => s.model);
  }

  /** Give each drive the id, label and device its position dictates. */
  private renumber(): void {
    this.states.forEach((s, i) => {
      s.id = 'abcd'[i] ?? String(i);
      s.label = `D${i + 1}:`;
      s.device = 0x31 + i;
    });
  }

  /**
   * Fit these drives. The drives already there keep their disks and take the
   * new model; extra ones are added empty, and surplus ones are removed with
   * whatever they held. Calling it with what is fitted already changes nothing.
   */
  configure(models: readonly AtariDriveModel[]): void {
    const want = normalizeDriveModels(models);
    while (this.states.length > want.length) this.states.pop();
    while (this.states.length < want.length) this.states.push(newDrive(want[this.states.length]));
    want.forEach((model, i) => { this.states[i].model = model; });
    this.renumber();
  }

  /** Change one drive's model; its disk stays in it. */
  setDriveModel(index: number, model: AtariDriveModel): void {
    const state = this.states[index];
    if (state) state.model = model;
  }

  /** Add an empty drive below `after`, of the same model; the drives under it
   *  move down. False at the limit. */
  addDrive(after: number): boolean {
    if (this.states.length >= ATARI_MAX_DRIVES) return false;
    const at = Math.min(Math.max(after, -1), this.states.length - 1) + 1;
    const model = this.states[at - 1]?.model ?? DEFAULT_DRIVE_MODEL;
    this.reshuffle(() => { this.states.splice(at, 0, newDrive(model)); });
    return true;
  }

  /** Remove a drive and its disk; the drives under it move up. The last
   *  drive stays. */
  removeDrive(index: number): boolean {
    if (this.states.length <= 1 || index < 0 || index >= this.states.length) return false;
    this.reshuffle(() => { this.states.splice(index, 1); });
    return true;
  }

  /** Write protect belongs to the drive position (the pane's switch), not to
   *  the drive that happens to sit there, so it stays put as drives move. */
  private reshuffle(change: () => void): void {
    const protect = this.states.map(s => s.writeProtected);
    change();
    this.renumber();
    this.states.forEach((s, i) => { s.writeProtected = protect[i] ?? false; });
  }

  /** Snapshot: the fitted drives, each with the disk it holds (as an ATR,
   *  writes included). */
  saveState(w: StateWriter): void {
    w.u8(this.states.length);
    for (const s of this.states) {
      w.str(s.model);
      w.str(s.name);
      w.bool(s.writeProtected);
      w.u32(s.track);
      w.u32(s.sector);
      w.bool(s.disk !== null);
      if (s.disk) w.bytes(s.disk.toBytes());
      w.bool(s.percom !== null);
      if (s.percom) w.bytes(s.percom);
    }
  }

  /** Put the drives a snapshot carried in place of the fitted ones. */
  loadState(r: StateReader): void {
    const count = r.u8();
    const entries: { model: AtariDriveModel; name: string; protect: boolean; track: number; sector: number; disk: AtariDisk | null; percom: Uint8Array | null }[] = [];
    for (let i = 0; i < count; i++) {
      const model = r.str() as AtariDriveModel;
      const name = r.str();
      const protect = r.bool();
      const track = r.u32();
      const sector = r.u32();
      let disk: AtariDisk | null = null;
      if (r.bool()) {
        disk = parseAtariDisk(r.bytes());
        if (!disk) throw new Error('Snapshot carries a disk image that cannot be read');
      }
      const percom = r.bool() ? r.bytes() : null;
      entries.push({ model, name, protect, track, sector, disk, percom });
    }
    this.configure(entries.map(e => e.model));
    this.states.forEach((s, i) => {
      const e = entries[i];
      if (!e) return;
      s.disk = e.disk;
      s.name = e.name;
      s.writeProtected = e.protect;
      s.track = e.track;
      s.sector = e.sector;
      s.percom = e.percom;
      s.dirty = false;
      s.motorOn = false;
      s.activity = 0;
    });
  }

  get drives(): readonly DriveDescriptor[] {
    return this.states.map(s => ({
      id: s.id,
      label: s.label,
      loaded: s.disk !== null,
      mediaName: s.name,
      writeProtected: s.writeProtected,
      motorOn: s.motorOn,
    }));
  }

  insert(id: string, media: DriveMedia, name: string): void {
    const state = this.byId(id);
    if (!state) return;
    let disk: AtariDisk | null = null;
    if (media instanceof Uint8Array) disk = parseAtariDisk(media);
    else if (isDskImage(media)) disk = atrFromDskImage(media);
    if (!disk) return;
    state.disk = disk;
    state.name = name;
    state.percom = null;
    state.lastOpFailed = false;
    state.writeProtected = false;
    state.dirty = false;
    state.track = 0;
    state.sector = 0;
    state.motorOn = false;
    state.activity = 0;
  }

  eject(id: string): void {
    const state = this.byId(id);
    if (!state) return;
    state.disk = null;
    state.name = '';
    state.percom = null;
    state.lastOpFailed = false;
    state.writeProtected = false;
    state.dirty = false;
    state.motorOn = false;
    state.activity = 0;
  }

  setWriteProtect(id: string, on: boolean): void {
    const state = this.byId(id);
    if (state) state.writeProtected = on;
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const state = this.byId(id);
    if (!state?.disk) return null;
    const base = baseName(state.name, `atari-disk-${state.id}`);
    return { data: state.disk.toBytes(), name: `${base}.atr` };
  }

  image(id: string): DskImage | null {
    return this.byId(id)?.disk?.toDskImage() ?? null;
  }

  /** Build the synthetic DskImage for panel slot 0-3 (a/b only). */
  diskImageForSlot(slot: number): DskImage | null {
    return this.states[slot]?.disk?.toDskImage() ?? null;
  }

  // ── Native SIO hooks ─────────────────────────────────────────────────────

  /** The drive addressed by an SIO device byte ($31/$32), or null. */
  driveForDevice(device: number): AtariDriveState | null {
    return this.states.find(s => s.device === device) ?? null;
  }

  /** The model of the drive at an SIO device number. */
  modelFor(device: number): AtariDriveModel {
    return this.driveForDevice(device)?.model ?? DEFAULT_DRIVE_MODEL;
  }

  /** True when the drive can read the disk in `device`. */
  canRead(device: number): boolean {
    const drive = this.driveForDevice(device);
    return drive?.disk != null && driveReads(drive.model, drive.disk);
  }

  readSector(device: number, sector: number): Uint8Array | null {
    const state = this.driveForDevice(device);
    if (!state?.disk) return null;
    const data = driveReads(state.model, state.disk) ? state.disk.readSector(sector) : null;
    state.lastOpFailed = !data;
    if (!data) return null;
    this.markAccess(state, sector, 2);
    return data;
  }

  writeSector(device: number, sector: number, data: Uint8Array): boolean {
    const state = this.driveForDevice(device);
    if (!state?.disk || state.writeProtected || !driveReads(state.model, state.disk)) return false;
    state.lastOpFailed = !state.disk.writeSector(sector, data);
    if (state.lastOpFailed) return false;
    state.dirty = true;
    this.markAccess(state, sector, 3);
    return true;
  }

  /**
   * Four-byte SIO status block.
   *
   *   0  drive status: bit 2 the last read or write failed, bit 3 write
   *      protected, bit 5 double density (sectors above 255 bytes), bit 6 two
   *      sides, bit 7 enhanced density (26 sectors a track). The format bits
   *      follow the PERCOM block a program has set, else the disk's own
   *   1  the controller's status register, inverted: $FF when all is well;
   *      bit 6 low while the disk is write protected, bit 7 low with no disk
   *   2  the format timeout the OS stores in DSKTIM ($E0; $FE on an XF551)
   *   3  unused
   */
  statusBytes(device: number): Uint8Array {
    const state = this.driveForDevice(device);
    const out = new Uint8Array([0x00, 0xFF, state?.model === 'xf551' ? 0xFE : 0xE0, 0x00]);
    const disk = state?.disk;
    if (!state || !disk) {
      out[1] = 0x7F; // not ready
      return out;
    }
    if (state.writeProtected) { out[0] |= 0x08; out[1] &= ~0x40; }
    if (state.lastOpFailed) out[0] |= 0x04;
    // A program that configured the drive has told it the format.
    const bits = percomStatusBits(state.percom ?? percomBlock(disk));
    out[0] |= bits & (state.model === '810' ? 0x20 : 0xe0);
    return out;
  }

  /** Called by the frame probe after the LED/track signals have been sampled. */
  clearActivity(): void {
    for (const state of this.states) {
      state.motorOn = false;
      state.activity = 0;
      state.dirty = false;
    }
  }

  private markAccess(state: AtariDriveState, sector: number, activity: 2 | 3): void {
    state.motorOn = true;
    state.activity = activity;
    state.track = Math.floor((sector - 1) / state.disk!.sectorsPerTrack);
    state.sector = ((sector - 1) % state.disk!.sectorsPerTrack) + 1;
  }

  private byId(id: string): AtariDriveState | null {
    return this.states.find(s => s.id === id) ?? null;
  }
}
