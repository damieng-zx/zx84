/**
 * Vic20MediaService — what a dropped file means on the VIC-20.
 *
 *  - `.tap`  a Datasette recording, played through the tape port (type LOAD).
 *  - `.prg`  a program file: put in memory as LOAD leaves it and RUN.
 *  - `.t64`  a tape archive: its first program, likewise.
 *  - `.d64` / `.g64`  a 1541 disk, put in a drive (device 8 first); `.d71` a
 *    1571's, `.d81` a 1581's.
 *  - `.vic20state`  a zx84 snapshot.
 *
 * `.prg` and `.t64` are also put on the Datasette as a KERNAL recording of
 * their programs, rewound with PLAY up, so the Tape pane names them and a
 * later LOAD finds them again.
 *
 * A program is written for a memory size, and its load address says which:
 * one at $1001 for an unexpanded machine, $0401 for the 3K, $1201 for 8K or
 * more, or machine code somewhere in the expansion blocks. When the RAM
 * fitted does not suit it, the RAM it needs is fitted first (the Hardware
 * pane follows), then the machine starts over with the program.
 *
 * Cartridges follow in Phase 4 of the plan.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { isT64, parsePrg, parseT64, type C64Program } from '@/media/tape/t64.ts';
import { isC64Tap } from '@/media/tape/c64-tap.ts';
import type { CbmTapeService } from '@/machines/shared/cbm/tape-service.ts';
import type { CbmDiskService } from '@/machines/shared/cbm/disk-service.ts';
import { CBM_DISK_PATTERN, CBM_DISK_TYPES, mountCbmDisk } from '@/machines/shared/cbm/drive-services.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import type { Vic20Machine } from '../vic20-machine.ts';
import { VIC20_STATE } from '../snapshots/vic20-state.ts';
import { VIC20_RAM_LABELS, vic20ExpansionFor, vic20RamChoiceFor } from '../options.ts';

export class Vic20MediaService implements MediaService {
  constructor(
    private readonly m: Vic20Machine,
    private readonly tape: CbmTapeService,
    private readonly disks: CbmDiskService,
    private readonly snapshots: NativeSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.tap', target: 'tape' },
      // Programs go into memory and also onto the cassette (as a recording of
      // them), so the Tape pane names them and LOAD finds them.
      { ext: '.prg', target: 'tape' },
      { ext: '.t64', target: 'tape' },
      ...CBM_DISK_TYPES,
      { ext: VIC20_STATE.ext, target: 'snapshot' },
    ];
  }

  /** Fit the RAM `prog` needs, if the RAM fitted will not do, and say what changed. */
  private fitFor(prog: C64Program): string {
    const m = this.m;
    const want = vic20ExpansionFor(prog.start, prog.data.length, m.memory.expansion);
    if (!want) return '';
    m.setRamExpansion(want);
    const choice = vic20RamChoiceFor(want) ?? 'none';
    m.host?.setTextSetting?.('vic20-ram', choice);
    m.host?.setFlagSetting?.('vic20-blk5', want.blk5);
    return ` (RAM set to ${VIC20_RAM_LABELS[choice]}${want.blk5 ? ' and BLK5' : ''})`;
  }

  /** Run `prog`, and put the file it came from on the tape. */
  private run(prog: C64Program, label: string, file: Uint8Array, name: string): MountResult {
    const fitted = this.fitFor(prog);
    this.m.injectProgram(prog, true);
    try {
      this.tape.mount(file, name);
    } catch { /* the program still runs; there is just no tape to show */ }
    return { ok: true, target: 'tape', message: `Loaded ${label}${fitted}` };
  }

  async mount(data: Uint8Array, filename: string, target?: MediaTargetId): Promise<MountResult> {
    const name = filename.replace(/^.*[\\/]/, '');
    if (/\.tap$/i.test(name)) {
      // .tap is also the ZX Spectrum's (unrelated) format.
      if (!isC64Tap(data)) return { ok: false, message: 'Not a Commodore tape — .tap is also a ZX Spectrum format' };
      let ok: boolean;
      try {
        ok = this.tape.mount(data, name);
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      if (!ok) return { ok: false, message: `${name} has no pulses on it` };
      const first = this.tape.files[0];
      const hint = first ? `LOAD "${first.name}"` : 'LOAD';
      return { ok: true, target: 'tape', message: `Tape: ${name} — type ${hint} (or SHIFT+RUN/STOP)` };
    }
    if (/\.t64$/i.test(name)) {
      if (!isT64(data)) return { ok: false, message: `${name} is not a T64 tape archive` };
      const programs = parseT64(data);
      const prog = programs.find(p => p.data.length > 0);
      if (!prog) return { ok: false, message: `${name} has no programs in it` };
      const more = programs.length > 1 ? ` (first of ${programs.length})` : '';
      return this.run(prog, `"${prog.name || name}"${more}`, data, name);
    }
    if (/\.prg$/i.test(name)) {
      let prog: C64Program;
      try {
        prog = parsePrg(data, name.replace(/\.prg$/i, ''));
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      return this.run(prog, name, data, name);
    }
    if (CBM_DISK_PATTERN.test(name)) {
      return mountCbmDisk(this.m.iec, this.disks, data, name, target, this.m.refreshResumed);
    }
    if (name.toLowerCase().endsWith(VIC20_STATE.ext)) {
      const r = await this.snapshots.apply(data, name);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      return r.ok
        ? { ok: true, target: 'snapshot', message: r.message }
        : { ok: false, message: r.message };
    }
    return { ok: false, message: 'The VIC-20 loads .tap tapes, .prg and .t64 programs, .d64, .g64, .d71 and .d81 disks and .vic20state snapshots' };
  }
}
