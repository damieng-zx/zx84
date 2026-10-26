/**
 * Atari media routing.
 *
 * Cartridges: 4K (mirrored), 8K and 16K images.
 * Disks: ATR and raw XFD sector dumps, into D1:/D2:.
 * Cassettes: `.cas` (FUJI) images, into the program recorder.
 *
 * A disk with no explicit target goes into the first empty drive (D1: when
 * both are empty), which is what a drag-and-drop user expects. A disk the
 * fitted drive model cannot read still mounts (as on the real machine, it
 * then fails with error 144), but the message says which drive it needs.
 */

import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { parseAtariDisk, type AtariDisk } from '@/media/floppy/atr.ts';
import { isAtariCas, parseAtariCas } from '@/media/tape/atari-cas.ts';
import { ATARI_DRIVE_MODELS, driveReads, minimumDriveFor } from '../drive-models.ts';
import type { AtariDiskService } from './disks.ts';
import type { AtariRomService } from './roms.ts';
import type { AtariTapeService } from './tape.ts';
import type { AtariMachine } from '../atari-machine.ts';
import { parseXex } from '../xex.ts';
import { parseCartridge } from '../cartridge.ts';
import {
  opsForDisk, opsForTape, planForDisk, planForTape, type AutostartOp, type TapePlan,
} from '../autostart.ts';

function fail(message: string): MountResult { return { ok: false, message }; }

export class AtariMediaService implements MediaService {
  constructor(
    private readonly roms: AtariRomService,
    private readonly disks: AtariDiskService,
    private readonly tape: AtariTapeService,
    private readonly m: AtariMachine,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.atr', target: 'a' },
      { ext: '.xfd', target: 'a' },
      { ext: '.cas', target: 'tape' },
      { ext: '.a8state', target: 'snapshot' },
      { ext: '.xex', target: 'snapshot' },
      { ext: '.com', target: 'snapshot' },
      { ext: '.rom', target: 'cartridge' },
      { ext: '.car', target: 'cartridge' },
      { ext: '.bin', target: 'cartridge' },
    ];
  }

  async mount(data: Uint8Array, filename: string, target?: MediaTargetId): Promise<MountResult> {
    if (/\.(atr|xfd)$/i.test(filename)) {
      const parsed = parseAtariDisk(data);
      if (!parsed) return fail(`Not a supported Atari disk image: ${filename}`);
      // The generic Load / drag-drop (no target) boots what it loads, from D1:.
      const auto = target === undefined;
      const id = auto ? 'a' : this.chooseDrive(target);
      if (id === null) return fail(`No such drive: ${target}`);
      const drive = this.disks.states.find(s => s.id === id)!;
      this.m.cancelAutostart();
      this.disks.insert(id, data, filename);
      if (id === 'a') this.m.clearXex(); // a real boot disk replaces an armed executable
      const label = drive.label;
      if (!driveReads(drive.model, parsed)) {
        const need = minimumDriveFor(parsed);
        const needLabel = ATARI_DRIVE_MODELS.find(d => d.value === need)?.label;
        const fitted = ATARI_DRIVE_MODELS.find(d => d.value === drive.model)?.label;
        return {
          ok: true,
          target: id,
          message: `Disk ${label} loaded: ${filename} — needs ${need === 'sio2pc' ? '' : 'an '}${needLabel}; the ${fitted} cannot read it`,
        };
      }
      const loaded = `Disk ${label} loaded: ${filename}`;
      return { ok: true, target: id, message: auto ? `${loaded}${this.autostartDisk(parsed, filename)}` : loaded };
    }

    if (/\.cas$/i.test(filename)) {
      this.m.cancelAutostart();
      if (!isAtariCas(data) || !this.tape.mount(data, filename)) {
        return fail(`Not an Atari cassette image (no FUJI header): ${filename}`);
      }
      const manual = `Cassette: ${filename} — CLOAD, or RUN "C:", or hold START at power-on to boot it`;
      return { ok: true, target: 'cas', message: target === undefined ? this.autostartTape(data, filename, manual) : manual };
    }

    if (/\.a8state$/i.test(filename)) {
      const r = await this.m.services.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      // A state carries its own cartridge, drives and tape: the panes re-read them.
      return r.ok ? { ok: true, target: 'snapshot', mediaChanged: true, message: r.message } : fail(r.message);
    }

    if (/\.(xex|com)$/i.test(filename)) {
      const segments = parseXex(data);
      if (!segments) return fail(`Not an Atari executable (no $FFFF header): ${filename}`);
      this.m.cancelAutostart();
      this.m.mountXex(segments, filename);
      return { ok: true, target: 'snapshot', message: `Executable: ${filename} — booting it` };
    }

    if (/\.(rom|car|bin)$/i.test(filename)) {
      const parsed = parseCartridge(data);
      if ('error' in parsed) return fail(`${parsed.error}: ${filename}`);
      this.m.clearXex();
      this.roms.cartridge.insert(data, filename);
      const kind = parsed.type.startsWith('oss') ? ` (OSS ${parsed.type.slice(4).toUpperCase()})` : '';
      return { ok: true, target: 'cartridge', message: `Cartridge: ${filename}${kind}` };
    }

    return fail('Atari 8-bit accepts .atr/.xfd disks, .xex/.com programs, .cas cassettes, .rom/.car/.bin cartridges and .a8state snapshots');
  }

  /** Boot the disk just put in D1: and start what is on it. Returns the
   *  tail of the status message. */
  private autostartDisk(disk: AtariDisk, filename: string): string {
    const plan = planForDisk(disk, filename);
    const ops = opsForDisk(plan);
    return this.startOps(ops, plan.kind === 'run-basic' ? `RUN "D:${plan.file}"`
      : plan.kind === 'dup-load' ? `booting DOS to load ${plan.file}`
      : `booting (BASIC ${plan.basic ? 'on' : 'off'})`);
  }

  private autostartTape(data: Uint8Array, filename: string, manual: string): string {
    const image = parseAtariCas(data);
    const plan = image ? planForTape(image) : ({ kind: 'none' } as TapePlan);
    const ops = opsForTape(plan);
    if (ops === null || plan.kind === 'none') return manual;
    this.m.clearXex();
    const what = plan.kind === 'boot' ? 'booting' : plan.via === 'CLOAD' ? 'RUN "C:"' : 'ENTER "C:" + RUN';
    return `Cassette: ${filename}${this.startOps(ops, what)}`;
  }

  /** Start a script; the message tail says what it does, or why it cannot. */
  private startOps(ops: readonly AutostartOp[], what: string): string {
    if (this.m.startAutostart(ops)) return ` — ${what}`;
    return ' — not auto-started (BASIC is needed, but a cartridge is fitted or no BASIC is available)';
  }

  /** The drive a target names, or null when there is no such drive. The
   *  Drives pane addresses drives as `unit:N`; restoring after a reload uses
   *  the drive ids. With no target: the first empty drive, else D1:. */
  private chooseDrive(target: MediaTargetId | undefined): string | null {
    const drives = this.disks.drives;
    if (target !== undefined) {
      const unit = /^unit:(\d+)$/.exec(target);
      const named = unit ? drives[Number(unit[1])] : drives.find(d => d.id === target);
      return named?.id ?? null;
    }
    return (drives.find(d => !d.loaded) ?? drives[0]).id;
  }
}
