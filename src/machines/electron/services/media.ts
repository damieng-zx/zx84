import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import type { AcornTapeService } from '@/machines/shared/acorn-tape-service.ts';
import { parseAdfs } from '@/media/floppy/adfs.ts';
import { parseSsd } from '@/media/floppy/ssd.ts';
import type { ElectronMachine } from '../electron-machine.ts';
import type { ElectronDiskService } from './disks.ts';

const ADFS_EXT = /\.(?:adf|adl|ads|adm)$/i;
const DFS_EXT = /\.(?:ssd|dsd)$/i;

/** The drive a mount target names: 'a' / 'b' directly, or the shell's
 *  family-agnostic `unit:N` hint (unit 0 = drive 0, unit 1 = drive 1). */
function driveOf(target: MediaTargetId | undefined): 'a' | 'b' {
  if (target === 'b') return 'b';
  const unit = /^unit:(\d+)$/.exec(target ?? '');
  return unit && Number(unit[1]) === 1 ? 'b' : 'a';
}

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
      const exts = this.machine.dfsFitted ? ['.ssd', '.dsd'] : ['.adf', '.adl', '.ads', '.adm'];
      for (const ext of exts) types.push({ ext, target: 'a' });
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
    if (ADFS_EXT.test(filename) || DFS_EXT.test(filename)) {
      if (!this.machine.plus3Fitted) {
        return { ok: false, message: 'Fit the Plus 3 in the Hardware pane to use discs' };
      }
      const dfsDisc = DFS_EXT.test(filename);
      if (dfsDisc !== this.machine.dfsFitted) {
        return {
          ok: false,
          message: dfsDisc
            ? 'Acorn DFS discs (.ssd/.dsd) need the Plus 3 set to DFS in the Hardware pane'
            : 'ADFS discs need the Plus 3 set to ADFS in the Hardware pane',
        };
      }
      const id = driveOf(target);
      if (id === 'b' && this.machine.driveCount < 2) {
        return { ok: false, message: 'Drive 1 is not fitted (change the drive count in the Drives pane)' };
      }
      try {
        // .adl is the double-sided L format even when the file has been trimmed;
        // .dsd is always two sides.
        const image = dfsDisc
          ? parseSsd(data, /\.dsd$/i.test(filename))
          : parseAdfs(data, /\.adl$/i.test(filename));
        this.disks.insert(id, image, filename);
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
    return {
      ok: false,
      message: 'The Electron accepts .uef/.csw tapes, .adf/.adl or .ssd/.dsd discs and .rom cartridges',
    };
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
