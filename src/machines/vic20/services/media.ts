/**
 * Vic20MediaService — what a dropped file means on the VIC-20.
 *
 *  - `.prg`  a program file: put in memory as LOAD leaves it and RUN.
 *  - `.t64`  a tape archive: its first program, likewise.
 *  - `.vic20state`  a zx84 snapshot.
 *
 * A program is written for a memory size, and its load address says which:
 * one at $1001 for an unexpanded machine, $0401 for the 3K, $1201 for 8K or
 * more, or machine code somewhere in the expansion blocks. When the RAM
 * fitted does not suit it, the RAM it needs is fitted first (the Hardware
 * pane follows), then the machine starts over with the program.
 *
 * Tapes, disks and cartridges follow in the later phases of the plan.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { isT64, parsePrg, parseT64, type C64Program } from '@/media/tape/t64.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import type { Vic20Machine } from '../vic20-machine.ts';
import { VIC20_STATE } from '../snapshots/vic20-state.ts';
import { VIC20_RAM_LABELS, vic20ExpansionFor, vic20RamChoiceFor } from '../options.ts';

export class Vic20MediaService implements MediaService {
  constructor(
    private readonly m: Vic20Machine,
    private readonly snapshots: NativeSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.prg', target: 'program' },
      { ext: '.t64', target: 'program' },
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

  private run(prog: C64Program, label: string): MountResult {
    const fitted = this.fitFor(prog);
    this.m.injectProgram(prog, true);
    return { ok: true, target: 'program', message: `Loaded ${label}${fitted}` };
  }

  async mount(data: Uint8Array, filename: string, _target?: MediaTargetId): Promise<MountResult> {
    const name = filename.replace(/^.*[\\/]/, '');
    if (/\.t64$/i.test(name)) {
      if (!isT64(data)) return { ok: false, message: `${name} is not a T64 tape archive` };
      const programs = parseT64(data);
      const prog = programs.find(p => p.data.length > 0);
      if (!prog) return { ok: false, message: `${name} has no programs in it` };
      const more = programs.length > 1 ? ` (first of ${programs.length})` : '';
      return this.run(prog, `"${prog.name || name}"${more}`);
    }
    if (/\.prg$/i.test(name)) {
      let prog: C64Program;
      try {
        prog = parsePrg(data, name.replace(/\.prg$/i, ''));
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      return this.run(prog, name);
    }
    if (name.toLowerCase().endsWith(VIC20_STATE.ext)) {
      const r = await this.snapshots.apply(data, name);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      return r.ok
        ? { ok: true, target: 'snapshot', message: r.message }
        : { ok: false, message: r.message };
    }
    return { ok: false, message: 'The VIC-20 loads .prg and .t64 programs and .vic20state snapshots so far' };
  }
}
