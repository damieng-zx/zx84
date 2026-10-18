import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { AcornTapeService } from '@/machines/shared/acorn-tape-service.ts';
import { parseAdfs } from '@/media/floppy/adfs.ts';
import type { ElectronMachine } from '../electron-machine.ts';
import type { ElectronDiskService } from './disks.ts';

const ADFS_EXT = /\.(?:adf|adl|ads|adm)$/i;

/** Acornsoft cartridges ship as two 16K dumps, `Name_1.rom` (lower bank) and
 *  `Name_2.rom` (upper bank). */
const HALF_ROM = /^(.*)_([12])\.rom$/i;
const BANK_SIZE = 0x4000;

interface CartridgeHalf {
  readonly stem: string;
  readonly which: 1 | 2;
  readonly data: Uint8Array;
  /** The cartridge name the half was mounted under, to tell it is still in. */
  readonly mountedAs: string;
}

/** Electron media routing: UEF and CSW cassettes always; ADFS discs once a Plus 3
 *  is fitted and `.rom` cartridges once a Plus 1 is. A disc loaded into drive 0
 *  is booted with SHIFT+BREAK, and a cartridge by the same, as a user would. */
export class ElectronMediaService implements MediaService {
  private half: CartridgeHalf | null = null;

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
      const [image, name] = this.pairHalves(data, filename);
      slot.insert(image, name);
      return { ok: true, target: 'cartridge', message: `Cartridge: ${name} (SHIFT+BREAK)` };
    }
    return { ok: false, message: 'The Electron accepts .uef/.csw tapes, .adf/.adl discs and .rom cartridges' };
  }

  /** A `_1`/`_2` half is a cartridge's lower or upper bank. Mounting the other
   *  half while the first is still the cartridge in the slot joins them into
   *  the one 32K cartridge, whichever order they arrive in; otherwise the half
   *  goes in on its own (a 16K image repeats across both banks). */
  private pairHalves(data: Uint8Array, filename: string): [Uint8Array, string] {
    const m = HALF_ROM.exec(filename);
    if (!m || data.length > BANK_SIZE) {
      this.half = null;
      return [data, filename];
    }
    const stem = m[1];
    const which = Number(m[2]) as 1 | 2;
    const prev = this.half;
    if (prev && prev.which !== which && prev.stem.toLowerCase() === stem.toLowerCase()
      && this.machine.cartridgeName === prev.mountedAs) {
      const [lo, hi] = which === 2 ? [prev.data, data] : [data, prev.data];
      const image = new Uint8Array(BANK_SIZE * 2);
      image.set(lo, 0);
      image.set(hi, BANK_SIZE);
      this.half = null;
      return [image, `${stem}_1+2.rom`];
    }
    this.half = { stem, which, data, mountedAs: filename };
    return [data, filename];
  }
}
