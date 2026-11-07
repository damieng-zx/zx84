/**
 * EnterpriseMediaService — what a dropped file means on this machine.
 *
 * EXDOS disks (.img, .dsk, .hfe, .scp) go to the disk card. Anything with an EXOS file header
 * (.com programs, .bas BASIC) goes to the FILE: device: the machine is reset
 * with the device's ROM fitted, and the typer runs it from BASIC. A whole
 * archive mounts as one set of files, because multi-part programs load their
 * other parts by name. `.epstate` is zx84's own snapshot.
 */

import type {
  ArchiveFile, MachineHost, MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
  SnapshotService,
} from '@/machines/machine.ts';
import {
  buildFatImage, fatFileFirstSector, fatRootDirectory, parseFatFloppy,
} from '@/media/floppy/fat-image.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { EnterpriseMachine } from '../enterprise-machine.ts';
import { exosFileType, HostFileBundle, isRunnableExosType } from '../hostfs.ts';
import { EnterpriseDiskService } from './disks.ts';

/** Extensions the FILE: device is offered on their own. */
const FILE_EXTS = ['.com', '.bas', '.prg', '.ep', '.app', '.exe'];
/** Disk files: raw sector dumps (.img; .dsk is either a raw dump or a CPC-style
 *  extended DSK, told apart by content) and HFE / SCP bitstream and flux images. */
const DISK_EXTS = ['.img', '.dsk', '.hfe', '.scp'];

/** Keyboard scans to let EXOS start before pressing a key at its title. */
const BOOT_SCANS = 30;

export class EnterpriseMediaService implements MediaService {
  constructor(
    private readonly m: EnterpriseMachine,
    private readonly disks: EnterpriseDiskService,
    private readonly host: () => MachineHost | null,
    private readonly snapshots: SnapshotService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    const out: MediaTypeDescriptor[] = FILE_EXTS.map(ext => ({ ext, target: 'file' }));
    out.push({ ext: '.epstate', target: 'snapshot' });
    if (this.m.exdos) for (const ext of DISK_EXTS) out.push({ ext, target: 'a' });
    return out;
  }

  async mount(data: Uint8Array, filename: string, target?: MediaTargetId): Promise<MountResult> {
    if (DISK_EXTS.some(ext => filename.toLowerCase().endsWith(ext))) return this.mountDisk(data, filename, target);
    this.disks.clearRemounts();
    if (/\.epstate$/i.test(filename)) {
      const r = await this.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      // A state file carries its drives: the panes re-read them.
      return r.ok ? { ok: true, target: 'snapshot', mediaChanged: true, message: r.message } : { ok: false, message: r.message };
    }
    if (!isRunnableExosType(exosFileType(data))) {
      return { ok: false, message: `${filename} is not an Enterprise program (no EXOS file header)` };
    }
    const bundle = new HostFileBundle();
    bundle.add(filename, data);
    bundle.keyFile = filename.replace(/^.*[\\/]/, '');
    return this.runBundle(bundle, filename);
  }

  async mountArchive(files: readonly ArchiveFile[], archiveName: string): Promise<MountResult | null> {
    this.disks.clearRemounts();
    // A disk in the archive: let the shell mount it the ordinary way.
    if (files.some(f => DISK_EXTS.some(ext => f.name.toLowerCase().endsWith(ext)))) return null;
    const key = pickKeyFile(files, archiveName);
    if (!key) return null;
    const bundle = new HostFileBundle();
    for (const f of files) bundle.add(f.name, f.data);
    bundle.keyFile = key.name.replace(/^.*[\\/]/, '');
    return this.runBundle(bundle, archiveName);
  }

  private mountDisk(data: Uint8Array, filename: string, target?: MediaTargetId): MountResult {
    if (!this.m.exdos) {
      return { ok: false, message: 'Fit the EXDOS disk card (Hardware pane) to use disks' };
    }
    let image: DskImage | null;
    try {
      image = parseFatFloppy(data, 'EXDOS IMG');
    } catch (err) {
      return { ok: false, message: `Disk error: ${(err as Error).message}` };
    }
    if (!image) return { ok: false, message: `${filename} is not a recognised EXDOS disk image` };
    const unit = target ? EnterpriseDiskService.unitOf(target) : 0;
    if (unit >= this.m.driveCount) return { ok: false, message: 'that drive is not fitted' };
    const id = ['a', 'b', 'c', 'd'][unit];
    // The shell putting back the disk a refresh-restored state was using:
    // it goes in as it was, with no restart.
    if (this.disks.takeRemount(unit, image, filename)) {
      return { ok: true, target: id, message: `Drive ${id.toUpperCase()}: ${filename}` };
    }
    this.disks.insert(id, image, filename);
    // A disk in A: restarts the machine (without the FILE: device in the way)
    // and starts the disk the way its owner would have.
    if (id === 'a') {
      this.m.setFileBundle(null);
      this.m.reset();
      this.m.typeText(diskStartCommand(image), { delayScans: BOOT_SCANS, skipSplash: true });
    }
    return { ok: true, target: id, message: `Drive ${id.toUpperCase()}: ${filename}` };
  }

  /**
   * Reset with the FILE: device serving `bundle`, and run its key file.
   *
   * With the EXDOS card fitted the same files also go on a fresh disk in
   * A:. Plenty of loaders name their next part on the disk (`DISK:`, `A:`,
   * EXDOS's own LOAD) rather than the default device, and with a disk in A:
   * EXDOS does not sit out its empty-drive timeout while EXOS starts.
   */
  private runBundle(bundle: HostFileBundle, label: string): MountResult {
    this.m.setFileBundle(bundle);
    if (this.m.exdos) {
      const disk = buildFatImage(bundle.entries);
      if (disk) this.disks.insert('a', disk.image, label.replace(/\.zip$/i, '.img'));
    }
    this.m.reset();
    this.m.typeText('RUN "FILE:"\n', { delayScans: BOOT_SCANS, skipSplash: true });
    this.host()?.setStatus(`Running ${bundle.keyFile}`);
    return { ok: true, target: 'file', message: `FILE: ${label} — running ${bundle.keyFile}` };
  }
}

/**
 * What to type once EXOS is up with a disk in A:. EXDOS runs an EXDOS.INI by
 * itself (the compilation disks' menus start that way), so nothing; a disk
 * with one EXOS program on it runs that; anything else gets a directory
 * listing — including a lone IS-DOS program, which BASIC cannot run.
 */
function diskStartCommand(image: DskImage): string {
  const visible = fatRootDirectory(image).filter(e => !(e.attributes & 0x12));   // not hidden, not a directory
  if (visible.some(e => e.name.toUpperCase() === 'EXDOS.INI')) return '';
  const programs = visible.filter(e => /\.(COM|BAS)$/i.test(e.name));
  if (programs.length === 1) {
    const head = fatFileFirstSector(image, programs[0]);
    if (head && isRunnableExosType(exosFileType(head))) return `RUN "${programs[0].name}"\n`;
  }
  return ':DIR\n';
}

/**
 * The program to start from a multi-file archive: an EXOS program or BASIC
 * file named after the archive (TOSEC names the loader that way), else the
 * first .com/.bas, else the first runnable file.
 */
function pickKeyFile(files: readonly ArchiveFile[], archiveName: string): ArchiveFile | null {
  const runnable = files.filter(f => isRunnableExosType(exosFileType(f.data)));
  if (runnable.length === 0) return null;
  const stem = (n: string): string => n.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '').toLowerCase();
  const want = stem(archiveName);
  return runnable.find(f => stem(f.name) === want)
    ?? runnable.find(f => /\.(com|bas)$/i.test(f.name))
    ?? runnable[0];
}
