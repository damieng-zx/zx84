import { baseName } from '@/machines/shared/disk-save.ts';
import type { DiskService, DriveDescriptor, DriveMedia } from '@/machines/machine.ts';
import { serializeAcornDisc } from '@/media/floppy/acorn-disc.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { readDskImage, writeDskImage } from '@/media/floppy/disk-state.ts';
import type { BbcMachine } from '../bbc-machine.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

/** The two physical DFS drives (0 and 1) backed by whichever disc controller
 *  (8271 or 1770) the machine has fitted. */
export class BbcDiskService implements DiskService {
  private readonly names = new Map<string, string>();

  constructor(private readonly machine: BbcMachine) {}

  private unit(id: string): number { return id === 'b' ? 1 : 0; }

  get drives(): readonly DriveDescriptor[] {
    if (!this.machine.disc) return [];
    const all = [this.describe('a', 'Drive 0', 0), this.describe('b', 'Drive 1', 1)];
    return all.slice(0, this.machine.driveCount);
  }

  insert(id: string, media: DriveMedia, name: string): void {
    if (this.unit(id) >= this.machine.driveCount) throw new Error('that drive is not fitted');
    this.machine.disc?.insertDisk(media as DskImage, this.unit(id));
    this.names.set(id, name);
  }

  /** Put a disc back in a drive without disturbing the controller (its head
   *  positions, its command in flight): the refresh-resume remount. */
  reattach(id: string, media: DriveMedia, name: string): void {
    const disc = this.machine.disc;
    if (!disc) return;
    const w = new StateWriter();
    disc.saveState(w);
    this.insert(id, media, name);
    disc.loadState(new StateReader(w.finish()));
  }

  eject(id: string): void {
    this.machine.disc?.ejectDisk(this.unit(id));
    this.names.delete(id);
  }

  save(id: string): { data: Uint8Array; name: string } | null {
    const disc = this.machine.disc;
    if (!disc) return null;
    const unit = this.unit(id);
    const image = disc.getDiskImage(unit);
    if (!image) return null;
    // A plain DFS layout saves as .ssd/.dsd; an HFE-sourced or irregular
    // (protected) disc as .hfe, so nothing on it is lost.
    const { data, ext } = serializeAcornDisc(image);
    disc.clearDirty(unit);
    return { data, name: `${baseName(this.names.get(id) ?? '')}${ext}` };
  }

  setWriteProtect(id: string, on: boolean): void {
    const disc = this.machine.disc;
    if (disc) disc.writeProtect[this.unit(id)] = on;
  }

  image(id: string): DskImage | null {
    return this.machine.disc?.getDiskImage(this.unit(id)) ?? null;
  }

  private describe(id: string, label: string, unit: number): DriveDescriptor {
    const disc = this.machine.disc;
    return {
      id,
      label,
      loaded: disc !== null && disc.getDiskImage(unit) !== null,
      mediaName: this.names.get(id) ?? '',
      writeProtected: disc ? disc.writeProtect[unit] : false,
      motorOn: disc !== null && disc.motorOn && disc.currentDrive === unit,
    };
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  /** Write both drives' discs as they are now (a guest's writes included),
   *  with their names and write-protect tabs. */
  saveState(w: StateWriter): void {
    const disc = this.machine.disc;
    for (let unit = 0; unit < 2; unit++) {
      const id = unit === 0 ? 'a' : 'b';
      const image = disc?.getDiskImage(unit) ?? null;
      w.bool(image !== null);
      if (!image || !disc) continue;
      w.str(this.names.get(id) ?? '');
      w.bool(disc.writeProtect[unit]);
      writeDskImage(w, image);
    }
  }

  /** Put the saved discs in the drives (an empty one is emptied). The
   *  controller's own state is restored afterwards, so this does not reset it. */
  loadState(r: StateReader): void {
    const disc = this.machine.disc;
    for (let unit = 0; unit < 2; unit++) {
      const id = unit === 0 ? 'a' : 'b';
      if (!r.bool()) {
        disc?.ejectDisk(unit);
        this.names.delete(id);
        continue;
      }
      const name = r.str();
      const protect = r.bool();
      const image = readDskImage(r);
      if (!disc) continue;
      disc.insertDisk(image, unit);
      disc.writeProtect[unit] = protect;
      this.names.set(id, name);
    }
  }
}
