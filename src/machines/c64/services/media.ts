/**
 * C64MediaService — what a dropped file means on the 64.
 *
 *  - `.tap`  a Datasette recording, played through the tape port (type LOAD).
 *  - `.t64`  a tape archive: its first program is put in memory and RUN.
 *  - `.prg`  a program file, likewise.
 *  - `.d64` / `.g64`  a 1541 disk, put in the drive (device 8).
 *  - `.c64state`  a zx84 snapshot.
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
import type { C64Machine } from '../c64-machine.ts';
import type { C64DiskService } from './disks.ts';
import type { C64TapeService } from './tape.ts';
import { C64_STATE } from '../snapshots/c64-state.ts';
import { C64_CART_TYPE_NAMES, parseCrt } from '../cartridge.ts';

export class C64MediaService implements MediaService {
  constructor(
    private readonly m: C64Machine,
    private readonly tape: C64TapeService,
    private readonly disks: C64DiskService,
    private readonly snapshots: NativeSnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.tap', target: 'tape' },
      // Programs go into memory and also onto the cassette (as a recording of
      // them), so the Tape pane names them and LOAD finds them.
      { ext: '.t64', target: 'tape' },
      { ext: '.prg', target: 'tape' },
      { ext: '.d64', target: 'a' },
      { ext: '.g64', target: 'a' },
      { ext: '.crt', target: 'cartridge' },
      { ext: C64_STATE.ext, target: 'snapshot' },
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

    if (/\.(d64|g64)$/i.test(name)) {
      // The shell remounting the persisted disk after a browser-refresh restore
      // names the drive; the restored drive is already running, so the disk
      // goes back in without the sensor seeing a change.
      const reattach = target === 'a' && this.m.refreshResumed;
      try {
        this.disks.mountImage('a', data, name, reattach);
      } catch (e) {
        return { ok: false, message: `Disk error: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (reattach) return { ok: true, target: 'a', message: `Drive 8 loaded: ${name}` };
      return { ok: true, target: 'a', message: `Drive 8 loaded: ${name} (try LOAD"$",8)` };
    }

    if (/\.crt$/i.test(name)) {
      const parsed = parseCrt(data);
      if ('error' in parsed) return { ok: false, message: `${parsed.error}: ${name}` };
      this.m.mountCartridge(parsed.cart, name);
      const kind = parsed.cart.type === 'normal' ? '' : ` (${C64_CART_TYPE_NAMES[parsed.cart.type]})`;
      return { ok: true, target: 'cartridge', message: `Cartridge: ${name}${kind}` };
    }

    if (name.toLowerCase().endsWith(C64_STATE.ext)) {
      const r = await this.snapshots.apply(data, name);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      return r.ok
        ? { ok: true, target: 'snapshot', message: r.message }
        : { ok: false, message: r.message };
    }

    return { ok: false, message: 'The C64 loads .tap tapes, .t64 and .prg programs, .d64 and .g64 disks, .crt cartridges and .c64state snapshots' };
  }
}
