/**
 * MSX MediaService — the machine's own file routing, ported verbatim from the
 * shell's MSX loadFile branch: `.rom` cartridges (auto-booted) and `.cas`
 * cassettes (BIOS-trap load). ZIP unwrapping stays a shell concern.
 *
 * The service mutates the machine only. The cartridge name / cassette block
 * signals, persistence and machine restart stay shell reflection, keyed off
 * MountResult.target.
 */

import type { MediaService, MediaTypeDescriptor, MediaTargetId, MountResult } from '@/machines/machine.ts';
import type { MsxRomService } from './roms.ts';
import type { MsxTapeService } from './tape.ts';

function fail(message: string): MountResult { return { ok: false, message }; }

export class MsxMediaService implements MediaService {
  constructor(
    private readonly roms: MsxRomService,
    private readonly tape: MsxTapeService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.rom', target: 'cartridge' },
      { ext: '.cas', target: 'tape' },
    ];
  }

  async mount(data: Uint8Array, filename: string, _target?: MediaTargetId): Promise<MountResult> {
    // Cartridge ROM: insert into slot 1 and power-cycle so the BIOS scan runs it.
    if (/\.rom$/i.test(filename)) {
      this.roms.cartridge.insert(data, filename);
      return { ok: true, target: 'cartridge', message: `Cartridge: ${filename}` };
    }

    // Cassette: mount the .cas; the BIOS TAPION/TAPIN traps serve it on CLOAD/BLOAD.
    if (/\.cas$/i.test(filename)) {
      this.tape.mount(data, filename);
      return { ok: true, target: 'cas', message: `Cassette: ${filename} — type CLOAD or BLOAD"CAS:"` };
    }

    return fail('MSX accepts .rom cartridges and .cas cassettes (or a .zip of one)');
  }
}
