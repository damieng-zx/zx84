/**
 * The Commodore serial (IEC) bus and the disk drives on it, as any Commodore
 * with a serial port (the C64, the VIC-20) sees them.
 *
 * Three open-collector lines, ATN, CLK and DATA: a line is low while the
 * computer or any drive pulls it. The computer owns how it drives its side
 * (CIA 2 port A on the 64, the two VIAs on the VIC-20) and hands the bus a
 * function that reads that side back; the bus tells the drives, and answers
 * which lines the drives pull.
 *
 * Up to four drives, devices 8 to 11, each a 1541, 1571 or 1581. A drive's
 * place on the bus is its device number. Each drive keeps its own clock; the
 * computer brings them up to its time (`syncTo`) at each bus access and at
 * frame end.
 */

import type { AuxRomRequest } from '@/machines/machine.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { Drive1541 } from './drive/drive-1541.ts';
import { Drive1571 } from './drive/drive-1571.ts';
import { Drive1581 } from './drive/drive-1581.ts';
import {
  CBM_DRIVE_ROM_SOURCES, CBM_MAX_DRIVES, isCbmDriveModel, type CbmDriveModel, type CbmDriveUnit,
} from './drive/drive-unit.ts';

/** The bits of the computer's side of the bus, as its `hostLines` reports
 *  them: a set bit is a line the computer holds low. */
export const IEC_ATN = 0x01;
export const IEC_CLK = 0x02;
export const IEC_DATA = 0x04;

function makeDrive(model: CbmDriveModel): CbmDriveUnit {
  if (model === '1581') return new Drive1581();
  return model === '1571' ? new Drive1571() : new Drive1541();
}

export class CbmSerialBus {
  private _drives: CbmDriveUnit[] = [];
  /** The drives the Drives pane has set up, one model each: what the next
   *  build fits (kept while the drives are unplugged). */
  driveModels: CbmDriveModel[] = ['1541'];

  /** `hostLines` reads which lines the computer holds low now
   *  (`IEC_ATN | IEC_CLK | IEC_DATA`). */
  constructor(private readonly hostLines: () => number) {}

  /** The disk drives on the bus, device 8 first; none while unplugged. */
  get drives(): readonly CbmDriveUnit[] { return this._drives; }
  /** The first drive (device 8), or null when none is fitted. */
  get drive(): CbmDriveUnit | null { return this._drives[0] ?? null; }
  /** The model of the first drive in the setup. */
  get driveModel(): CbmDriveModel { return this.driveModels[0] ?? '1541'; }
  /** Any drive is on the bus. */
  get fitted(): boolean { return this._drives.length > 0; }

  /** A drive pulls CLK low. */
  get clkLow(): boolean { return this._drives.some(d => d.clkAsserted); }
  /** A drive pulls DATA low. */
  get dataLow(): boolean { return this._drives.some(d => d.dataAsserted); }

  /** Tell the drives which lines the computer pulls low (after it changed
   *  its side of the bus, or the drives changed). */
  update(): void {
    const lines = this.hostLines();
    const atn = (lines & IEC_ATN) !== 0, clk = (lines & IEC_CLK) !== 0, data = (lines & IEC_DATA) !== 0;
    for (const d of this._drives) d.setHostLines(atn, clk, data);
  }

  /** Bring the drives up to the computer's cycle `t`, at `hostHz`. */
  syncTo(t: number, hostHz: number): void {
    for (const d of this._drives) d.runTo(Math.floor(t * d.clockHz / hostHz));
  }

  /** Every drive starts over (the computer was reset). */
  reset(): void {
    if (this._drives.length === 0) return;
    for (const d of this._drives) d.reset();
    this.update();
  }

  /** Take every drive off the bus; the setup stays for the next build. */
  unplug(): void { this._drives = []; }

  /** Give each drive the device number its place dictates. A drive that moved
   *  starts over (the DOS reads its jumpers at power-on); write protect belongs
   *  to the place, as the pane's switch does, not to the drive that sits there. */
  private renumber(protect: readonly boolean[]): void {
    this._drives.forEach((d, i) => {
      const moved = d.unit !== i;
      d.unit = i;
      const want = protect[i] ?? false;
      if (d.writeProtected !== want) d.setWriteProtect(want);
      if (moved && d.hasRom) d.reset();
    });
    this.driveModels = this._drives.map(d => d.model);
    this.update();
  }

  /** Fit these drives, device 8 first. A drive already in its place keeps its
   *  disk if the model is the same; the others are new and empty. */
  fitDrives(models: readonly CbmDriveModel[]): void {
    const old = this._drives;
    this._drives = models.map((model, i) => {
      const drive = old[i]?.model === model ? old[i] : makeDrive(model);
      drive.unit = i;
      return drive;
    });
    if (models.length > 0) this.driveModels = [...models];
    this.update();
  }

  /** Put the DOS ROM in every drive of that model. */
  installDriveRom(model: CbmDriveModel, rom: Uint8Array): void {
    for (const d of this._drives) if (d.model === model) d.loadRom(rom);
    this.update();
  }

  /** Fit a drive running the DOS in `rom` (the 16K image of a 1541, the 32K
   *  of a 1571 or 1581), or take every drive off the bus (null). With no drive
   *  of that model fitted yet, it becomes the one drive. */
  installDrive(rom: Uint8Array | null, model: CbmDriveModel = this.driveModel): void {
    if (rom === null) { this.unplug(); return; }
    if (!this._drives.some(d => d.model === model)) this.fitDrives([model]);
    this.installDriveRom(model, rom);
  }

  /** The ROM of a fitted drive of `model`, to lend a new one. */
  private romOf(model: CbmDriveModel): Uint8Array | undefined {
    return this._drives.find(d => d.model === model && d.hasRom)?.rom;
  }

  /** Put an empty drive of `model` at place `at`, the drives from there moving
   *  down a device number. Needs a drive of that model fitted already, whose
   *  ROM it copies; false when there is no room. */
  insertDriveAt(at: number, model: CbmDriveModel): boolean {
    if (this._drives.length >= CBM_MAX_DRIVES) return false;
    const rom = this.romOf(model);
    if (!rom) return false;
    const protect = this._drives.map(d => d.writeProtected);
    const drive = makeDrive(model);
    drive.loadRom(rom);
    this._drives.splice(Math.max(0, Math.min(at, this._drives.length)), 0, drive);
    this.renumber(protect);
    return true;
  }

  /** Take a drive out with its disk, the drives under it moving up. */
  removeDriveAt(index: number): boolean {
    if (this._drives.length <= 1 || index < 0 || index >= this._drives.length) return false;
    const protect = this._drives.map(d => d.writeProtected);
    this._drives.splice(index, 1);
    this.renumber(protect);
    return true;
  }

  /** Swap one drive for another model, with its ROM from a drive of that model
   *  already fitted; false when there is none (the machine must be rebuilt). */
  replaceDriveAt(index: number, model: CbmDriveModel): boolean {
    const rom = this.romOf(model);
    if (!rom || index < 0 || index >= this._drives.length) return false;
    const protect = this._drives.map(d => d.writeProtected);
    const drive = makeDrive(model);
    drive.loadRom(rom);
    this._drives[index] = drive;
    this.renumber(protect);
    return true;
  }

  /** The DOS ROMs the fitted drives need, one request per model, fetched
   *  before the machine starts. `keyPrefix` names the cache entries and the
   *  failure signals (`<prefix><model>-rom`, `<prefix><model>`). */
  romRequests(keyPrefix: string): AuxRomRequest[] {
    return [...new Set(this._drives.map(d => d.model))].map((model): AuxRomRequest => ({
      cacheKey: `${keyPrefix}${model}-rom`,
      source: CBM_DRIVE_ROM_SOURCES[model],
      fetchingMsg: `Fetching ${model} DOS ROM...`,
      loadedMsg: (bytes) => `${model} DOS ROM loaded (${bytes} bytes)`,
      failMsg: `Failed to load the ${model} DOS ROM: disk drive unavailable`,
      failId: keyPrefix + model,
      apply: (data) => this.installDriveRom(model, data),
      awaitLoad: true,
    }));
  }

  // ── Snapshots ────────────────────────────────────────────────────────────

  /** One DRVM (the model), DRV and MEDA (the disk, when `withMedia`) section
   *  for each drive with a ROM, device 8 first. */
  saveState(w: StateWriter, withMedia: boolean): void {
    for (const drive of this._drives) {
      if (!drive.hasRom) continue;
      w.section('DRVM', () => w.str(drive.model));
      w.section('DRV ', () => drive.saveState(w));
      w.section('MEDA', () => {
        w.bool(withMedia);
        if (withMedia) drive.saveDisk(w);
      });
    }
  }

  /** Read the drive sections back into the drives fitted (which must match
   *  them, model for model); drives the snapshot did not have start over.
   *  Returns whether the snapshot carried its disks (true when it has no
   *  drives). A missing DRVM section (states from before the 1581) is a 1541. */
  loadState(r: StateReader): boolean {
    let withMedia = true;
    let n = 0;
    while (r.peekSection('DRVM') || r.peekSection('DRV ')) {
      let model: CbmDriveModel = '1541';
      if (r.peekSection('DRVM')) {
        const named = r.section('DRVM').str();
        if (isCbmDriveModel(named)) model = named;
      }
      const state = r.section('DRV ');
      const media = r.section('MEDA');
      withMedia = media.bool();
      if (this._drives.length > 0) {
        const drive = this._drives[n];
        if (!drive) {
          throw new Error(`This snapshot has more drives than are set up: add drives in the Drives pane first (it has ${n + 1} or more)`);
        }
        if (drive.model !== model) {
          throw new Error(`This snapshot has a ${model} drive as device ${8 + n}: set that drive to a ${model} in the Drives pane first`);
        }
        if (drive.hasRom) {
          drive.loadState(state);
          if (withMedia) drive.loadDisk(media);
        }
      }
      n++;
    }
    for (let i = n; i < this._drives.length; i++) if (this._drives[i].hasRom) this._drives[i].reset();
    this.update();
    return withMedia;
  }
}
