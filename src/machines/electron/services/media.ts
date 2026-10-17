import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { AcornTapeService } from '@/machines/shared/acorn-tape-service.ts';
import { parseAdfs } from '@/media/floppy/adfs.ts';
import type { ElectronMachine } from '../electron-machine.ts';
import type { ElectronDiskService } from './disks.ts';

const ADFS_EXT = /\.(?:adf|adl|ads|adm)$/i;

/** Electron media routing: UEF and CSW cassettes always; ADFS discs once a Plus 3
 *  is fitted and `.rom` cartridges once a Plus 1 is. A disc loaded into drive 0
 *  is booted with SHIFT+BREAK, and a cartridge by the same, as a user would. */
export class ElectronMediaService implements MediaService {
  constructor(
    private readonly machine: ElectronMachine,
    private readonly disks: ElectronDiskService,
    private readonly tape: AcornTapeService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    const types: MediaTypeDescriptor[] = [
      { ext: '.uef', target: 'tape' },
      { ext: '.csw', target: 'tape' },
    ];
    if (this.machine.plus3Fitted) {
      for (const ext of ['.adf', '.adl', '.ads', '.adm']) types.push({ ext, target: 'a' });
    }
    if (this.machine.plus1Fitted) types.push({ ext: '.rom', target: 'cartridge' });
    return types;
  }

  async mount(
    data: Uint8Array,
    filename: string,
    target?: MediaTargetId,
  ): Promise<MountResult> {
    if (/\.(?:uef|csw)$/i.test(filename)) {
      if (!(await this.tape.mountBytes(data, filename))) {
        return { ok: false, message: `Tape error: ${filename} is not a readable UEF or CSW image` };
      }
      return {
        ok: true,
        target: 'tape',
        message: `Tape loaded: ${filename} — type CHAIN"" (or *RUN)`,
      };
    }
    if (ADFS_EXT.test(filename)) {
      if (!this.machine.plus3Fitted) {
        return { ok: false, message: 'Fit the Plus 3 in the Hardware pane to use discs' };
      }
      const id = target === 'b' ? 'b' : 'a';
      try {
        // .adl is the double-sided L format even when the file has been trimmed.
        this.disks.insert(id, parseAdfs(data, /\.adl$/i.test(filename)), filename);
      } catch (err) {
        return { ok: false, message: `Disk error: ${(err as Error).message}` };
      }
      if (id === 'a') this.machine.bootWithShift();
      return {
        ok: true,
        target: id,
        message: id === 'a' ? `Drive 0 loaded: ${filename} (SHIFT+BREAK)` : `Drive 1 loaded: ${filename}`,
      };
    }
    if (/\.rom$/i.test(filename)) {
      const slot = this.machine.services.roms.cartridge;
      if (!slot) {
        return { ok: false, message: 'Fit the Plus 1 in the Hardware pane to use cartridges' };
      }
      slot.insert(data, filename);
      return { ok: true, target: 'cartridge', message: `Cartridge: ${filename} (SHIFT+BREAK)` };
    }
    return { ok: false, message: 'The Electron accepts .uef/.csw tapes, .adf/.adl discs and .rom cartridges' };
  }
}
