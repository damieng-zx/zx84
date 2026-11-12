/**
 * C128MediaService — what a dropped file means on the 128.
 *
 *  - `.tap`  a Datasette recording, played through the tape port (type LOAD).
 *  - `.t64`  a tape archive: its first program is put in memory and RUN.
 *  - `.prg`  a program file, likewise. A BASIC program says which mode it is
 *            for by where it starts: BASIC 7.0's at $1C01 starts the 128 in
 *            C128 mode, the 64's at $0801 starts it in C64 mode.
 *  - `.d64` / `.g64`  a 1541 disk, put in the drive (device 8); a 1571 reads them too.
 *  - `.d71`  a double-sided disk for a 1571.
 *  - `.d81`  a 3.5" disk for a 1581.
 *  - `.c128state`  a zx84 snapshot.
 *
 * `.t64` and `.prg` are files rather than recordings, so they go straight
 * into memory the way LOAD leaves them (BASIC's pointers set) instead of
 * through the tape port. They are also put on the Datasette as a KERNAL
 * recording of their programs, rewound with PLAY up, so the Tape pane names
 * them and a later LOAD finds them again.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { isC64Tap } from '@/media/tape/c64-tap.ts';
import { isT64, parsePrg, parseT64 } from '@/media/tape/t64.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import type { C128Machine } from '../c128-machine.ts';
import type { CbmDiskService } from '@/machines/shared/cbm/disk-service.ts';
import type { CbmTapeService } from '@/machines/shared/cbm/tape-service.ts';
import { C128_STATE } from '../snapshots/c128-state.ts';
import { CBM_DISK_PATTERN, CBM_DISK_TYPES, mountCbmDisk } from '@/machines/shared/cbm/drive-services.ts';

export class C128MediaService implements MediaService {
  constructor(
    private readonly m: C128Machine,
    private readonly tape: CbmTapeService,
    private readonly disks: CbmDiskService,
    private readonly snapshots: NativeSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.tap', target: 'tape' },
      // Programs go into memory and also onto the cassette (as a recording of
      // them), so the Tape pane names them and LOAD finds them.
      { ext: '.t64', target: 'tape' },
      { ext: '.prg', target: 'tape' },
      ...CBM_DISK_TYPES,
      { ext: C128_STATE.ext, target: 'snapshot' },
    ];
  }

  /** Mount the programs as a tape, after the machine has been reset for them
   *  (a reset leaves the deck alone, but a program may not be taped at all). */
  private putOnTape(data: Uint8Array, name: string): void {
    try {
      this.tape.mount(data, name);
    } catch { /* the program still runs; there is just no tape to show */ }
  }

  async mount(data: Uint8Array, filename: string, target?: MediaTargetId): Promise<MountResult> {
    const name = filename.replace(/^.*[\\/]/, '');
    if (/\.tap$/i.test(name)) {
      // .tap is also the ZX Spectrum's (unrelated) format.
      if (!isC64Tap(data)) return { ok: false, message: 'Not a C64 tape — .tap is also a ZX Spectrum format' };
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
      this.m.injectProgram(prog, true);
      this.putOnTape(data, name);
      const more = programs.length > 1 ? ` (first of ${programs.length})` : '';
      return { ok: true, target: 'tape', message: `Loaded "${prog.name || name}"${more}` };
    }

    if (/\.prg$/i.test(name)) {
      let prog;
      try {
        prog = parsePrg(data, name.replace(/\.prg$/i, ''));
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      this.m.injectProgram(prog, true);
      this.putOnTape(data, name);
      return { ok: true, target: 'tape', message: `Loaded ${name}` };
    }

    if (CBM_DISK_PATTERN.test(name)) {
      return mountCbmDisk(this.m.iec, this.disks, data, name, target, this.m.refreshResumed);
    }

    if (name.toLowerCase().endsWith(C128_STATE.ext)) {
      const r = await this.snapshots.apply(data, name);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      return r.ok
        ? { ok: true, target: 'snapshot', message: r.message }
        : { ok: false, message: r.message };
    }

    return { ok: false, message: 'The C128 loads .tap tapes, .t64 and .prg programs, .d64, .g64, .d71 and .d81 disks and .c128state snapshots' };
  }
}
