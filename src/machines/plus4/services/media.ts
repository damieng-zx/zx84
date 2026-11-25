/**
 * Plus4MediaService — what a dropped file means on the Plus/4.
 *
 *  - `.tap`  a Datasette recording, played through the tape port (type LOAD).
 *  - `.prg`  a program file: put in memory as LOAD leaves it and RUN.
 *  - `.t64`  a tape archive: its first program, likewise.
 *  - `.d64` / `.g64`  a 1541 disk, put in a drive (device 8 first); `.d71` a
 *    1571's, `.d81` a 1581's.
 *  - `.crt`, `.bin`  a cartridge (see `cartridge.ts`).
 *  - `.plus4state`  a zx84 snapshot.
 *
 * `.prg` and `.t64` are also put on the Datasette as a KERNAL recording of
 * their programs, rewound with PLAY up, so the Tape pane names them and a
 * later LOAD finds them again.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { isT64, parsePrg, parseT64, type C64Program } from '@/media/tape/t64.ts';
import { isC64Tap, tapFormat } from '@/media/tape/c64-tap.ts';
import type { CbmTapeService } from '@/machines/shared/cbm/tape-service.ts';
import type { CbmDiskService } from '@/machines/shared/cbm/disk-service.ts';
import { CBM_DISK_PATTERN, CBM_DISK_TYPES, mountCbmDisk } from '@/machines/shared/cbm/drive-services.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import type { Plus4Machine } from '../plus4-machine.ts';
import { PLUS4_STATE } from '../snapshots/plus4-state.ts';
import { parsePlus4Cartridge } from '../cartridge.ts';

export class Plus4MediaService implements MediaService {
  constructor(
    private readonly m: Plus4Machine,
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
      { ext: '.crt', target: 'cartridge' },
      { ext: '.bin', target: 'cartridge' },
      { ext: PLUS4_STATE.ext, target: 'snapshot' },
    ];
  }

  /** Run `prog`, and put the file it came from on the tape. */
  private run(prog: C64Program, label: string, file: Uint8Array, name: string): MountResult {
    this.m.injectProgram(prog, true);
    try {
      this.tape.mount(file, name);
    } catch { /* the program still runs; there is just no tape to show */ }
    return { ok: true, target: 'tape', message: `Loaded ${label}` };
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
    if (/\.(crt|bin)$/i.test(name)) {
      const parsed = parsePlus4Cartridge(data, name);
      if ('error' in parsed) return { ok: false, message: `${parsed.error}: ${name}` };
      this.m.mountCartridge(parsed.cart, name);
      return { ok: true, target: 'cartridge', message: `Cartridge: ${name}` };
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
    if (name.toLowerCase().endsWith(PLUS4_STATE.ext)) {
      const r = await this.snapshots.apply(data, name);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      return r.ok
        ? { ok: true, target: 'snapshot', message: r.message }
        : { ok: false, message: r.message };
    }
    return {
      ok: false,
      message: 'The Plus/4 loads .tap tapes, .prg and .t64 programs, .d64, .g64, .d71 and .d81 disks, .crt and .bin cartridges and .plus4state snapshots',
    };
  }
}

/** The .tap platform byte for a generated recording: 2 is the C16/Plus/4. */
export const PLUS4_TAP_PLATFORM = 2;

/** The tape format a machine writes. */
export function plus4TapFormat(ntsc: boolean) {
  return tapFormat(PLUS4_TAP_PLATFORM, ntsc ? 1 : 0);
}
