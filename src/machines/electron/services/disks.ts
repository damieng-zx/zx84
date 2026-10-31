import { baseName } from '@/machines/shared/disk-save.ts';
import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import { serializeAcornDisc } from '@/media/floppy/acorn-disc.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { readDskImage, writeDskImage } from '@/media/floppy/disk-state.ts';
import type { ElectronMachine } from '../electron-machine.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

/** The Plus 3's two drives (0 and 1) on its WD1770. With no Plus 3 fitted there
 *  are no drives, so the Drives pane has nothing to show. */
export class ElectronDiskService implements DiskService {
  private readonly names = new Map<string, string>();

  constructor(private readonly machine: ElectronMachine) {}

  private unit(id: string): number { return id === 'b' ? 1 : 0; }

  get drives(): readonly DriveDescriptor[] {
    if (!this.machine.plus3Fitted) return [];
    const all = [this.describe('a', 'Drive 0', 0), this.describe('b', 'Drive 1', 1)];
    return all.slice(0, this.machine.driveCount);
  }

  insert(id: string, media: DriveMedia, name: string): void {
    if (this.unit(id) >= this.machine.driveCount) throw new Error('that drive is not fitted');
    this.machine.plus3.insertDisk(media as DskImage, this.unit(id));
    this.names.set(id, name);
  }

  eject(id: string): void {
    this.machine.plus3.ejectDisk(this.unit(id));
    this.names.delete(id);
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const plus3 = this.machine.plus3;
    const unit = this.unit(id);
    const image = plus3.getDiskImage(unit);
    if (!image) return null;
    // Plain DFS and ADFS layouts save as their sector dumps; an HFE-sourced or
    // irregular (protected) disc as .hfe, so nothing on it is lost.
    const { data, ext } = serializeAcornDisc(image);
    plus3.clearDirty(unit);
    return { data, name: `${baseName(this.names.get(id) ?? '')}${ext}` };
  }

  setWriteProtect(id: string, on: boolean): void {
    this.machine.plus3.writeProtect[this.unit(id)] = on;
  }

  image(id: string): DskImage | null {
    return this.machine.plus3.getDiskImage(this.unit(id));
  }

  private describe(id: string, label: string, unit: number): DriveDescriptor {
    const plus3 = this.machine.plus3;
    return {
      id,
      label,
      loaded: plus3.getDiskImage(unit) !== null,
      mediaName: this.names.get(id) ?? '',
      writeProtected: plus3.writeProtect[unit],
      motorOn: plus3.motorOn && plus3.currentDrive === unit,
    };
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  /** Put a disc back in a drive without disturbing the controller (its head
   *  positions, its command in flight): the refresh-resume remount. */
  reattach(id: string, media: DriveMedia, name: string): void {
    const plus3 = this.machine.plus3;
    const w = new StateWriter();
    plus3.saveState(w);
    this.insert(id, media, name);
    plus3.loadState(new StateReader(w.finish()));
  }

  /** Write both drives' discs as they are now (a guest's writes included),
   *  with their names and write-protect tabs. */
  saveState(w: StateWriter): void {
    const plus3 = this.machine.plus3;
    for (let unit = 0; unit < 2; unit++) {
      const image = plus3.getDiskImage(unit);
      w.bool(image !== null);
      if (!image) continue;
      w.str(this.names.get(unit === 0 ? 'a' : 'b') ?? '');
      w.bool(plus3.writeProtect[unit]);
      writeDskImage(w, image);
    }
  }

  /** Put the saved discs in the drives (an empty one is emptied). The
   *  controller's own state is restored afterwards. */
  loadState(r: StateReader): void {
    const plus3 = this.machine.plus3;
    for (let unit = 0; unit < 2; unit++) {
      const id = unit === 0 ? 'a' : 'b';
      if (!r.bool()) {
        plus3.ejectDisk(unit);
        this.names.delete(id);
        continue;
      }
      const name = r.str();
      const protect = r.bool();
      plus3.insertDisk(readDskImage(r), unit);
      plus3.writeProtect[unit] = protect;
      this.names.set(id, name);
    }
  }
}
