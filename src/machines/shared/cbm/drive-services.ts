/**
 * The parts of a Commodore's services that are about its serial-bus disk
 * drives, shared by the C64 and the VIC-20: which drive a dropped disk goes
 * in, the DOS ROM sockets on the ROM pane, the drive LEDs and floppy sound in
 * the frame probe, and the drives' sections of the debugger's chip dump.
 */

import type { FrameIndicators, MediaTypeDescriptor, MountResult, SidewaysRomSlot } from '@/machines/machine.ts';
import type { ChipSection } from '@/debug/chip-state.ts';
import { hex8, hex16 } from '@/utils/hex.ts';
import type { CbmDiskService } from './disk-service.ts';
import { CBM_DRIVE_MODELS, type CbmDriveModel, type CbmDriveUnit } from './drive/drive-unit.ts';
import type { CbmSerialBus } from './serial-bus.ts';

/** The disk images a Commodore drive reads. */
export const CBM_DISK_PATTERN = /\.(d64|g64|g41|d71|d81)$/i;

/** Every disk format, whichever drives are set up: a ZIP or a file picker
 *  filters by these, and a disk for a model that is not fitted gets a message
 *  saying which drive to set up rather than being passed over. */
export const CBM_DISK_TYPES: readonly MediaTypeDescriptor[] = [
  { ext: '.d64', target: 'a' },
  { ext: '.d71', target: 'a' },
  { ext: '.g64', target: 'a' },
  { ext: '.g41', target: 'a' },
  { ext: '.d81', target: 'a' },
];

/**
 * Put a disk file in a drive. The shell may name the drive ('a'-'d', or
 * 'unit:n'); otherwise it goes in the first drive that reads the format, an
 * empty one first. When none reads it, the first empty drive (else the first)
 * is asked to become the model that does (`needsDriveModel`), so a .d81 on a
 * stock 1541 machine just works. `reattach` (a named drive after a browser-
 * refresh restore) puts back the disk the restored drive already had, without
 * the drive noticing a change.
 */
export function mountCbmDisk(
  bus: CbmSerialBus, disks: CbmDiskService,
  data: Uint8Array, name: string, target: string | undefined, refreshResumed: boolean,
): MountResult {
  // The model a disk is made for; a 1571 also reads the 1541's.
  const wants: CbmDriveModel = /\.d81$/i.test(name) ? '1581' : /\.d71$/i.test(name) ? '1571' : '1541';
  const reads = (model: CbmDriveModel): boolean => (wants === '1541' ? model !== '1581' : model === wants);
  const drives = bus.drives;
  const named = /^(?:unit:)?([0-3a-d])$/.exec(target ?? '');
  const asked = named ? (/\d/.test(named[1]) ? Number(named[1]) : 'abcd'.indexOf(named[1])) : -1;
  let at = asked >= 0 && asked < drives.length ? asked : -1;
  if (at < 0 && drives.length > 0) {
    const fits = drives.map((_, i) => i).filter(i => reads(drives[i].model));
    at = fits.find(i => !drives[i].loaded) ?? fits[0] ?? -1;
    if (at < 0 && asked < 0) at = Math.max(0, drives.findIndex(d => !d.loaded));
  }
  const drive = drives[at];
  if (drive && !reads(drive.model)) {
    const have = drive.model;
    const formats = have === '1541' ? '.d64 and .g64' : have === '1571' ? '.d64, .g64 and .d71' : '.d81';
    return {
      ok: false,
      needsDriveModel: { index: at, model: wants },
      message: `Drive ${8 + at} is a ${have}, which reads ${formats} disks: set it to a ${wants} in the Drives pane (the drive's ... menu, Model) or add a ${wants} drive there, to use ${name}`,
    };
  }
  const reattach = named !== null && refreshResumed;
  const id = 'abcd'[at] ?? 'a';
  try {
    disks.mountImage(id, data, name, reattach);
  } catch (e) {
    return { ok: false, message: `Disk error: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (reattach) return { ok: true, target: id, message: `Drive ${8 + at} loaded: ${name}` };
  return { ok: true, target: id, message: `Drive ${8 + at} loaded: ${name} (try LOAD"*",${8 + at},1)` };
}

/** The DOS ROMs as ROM-pane sockets of their own, one per drive model fitted
 *  (the drives of a model share it). The index is the model's, so a stored
 *  override stays with its model whichever drives are fitted. */
export function cbmDriveRomSlots(bus: CbmSerialBus): SidewaysRomSlot[] {
  const out: SidewaysRomSlot[] = [];
  CBM_DRIVE_MODELS.forEach((model, index) => {
    const drive = bus.drives.find(d => d.model === model);
    if (!drive) return;
    out.push({
      index,
      title: `${model} DOS`,
      label: drive.hasRom ? `${model} DOS ROM` : '',
      size: drive.hasRom ? drive.romSize : 0,
      overridden: false,
    });
  });
  return out;
}

/** Put a DOS ROM in the drives of the model at socket `index`. */
export function installCbmDriveRom(bus: CbmSerialBus, index: number, data: Uint8Array): void {
  const model = CBM_DRIVE_MODELS[index];
  if (model) bus.installDriveRom(model, data);
}

/** The drive LEDs, tracks and floppy sound into the frame probe's indicators. */
export function sampleCbmDrives(out: FrameIndicators, drives: readonly CbmDriveUnit[]): void {
  out.disk = 0;
  for (let unit = 0; unit < 4; unit++) out.driveLed[unit] = -1;
  out.floppySlot = -1;
  out.floppyMotor = false;
  // 0 off, 1 motor, 2 reading, 3 writing: a drive's LED is lit while it works.
  drives.forEach((drive, unit) => {
    out.driveLed[unit] = !drive.motorOn ? 0 : drive.isWriting ? 3 : drive.ledOn ? 2 : 1;
    out.driveTrack[unit] = drive.currentTrack;
    out.driveSector[unit] = -1;
    out.driveDirty[unit] = drive.dirty ? 1 : 0;
    if (drive.motorOn) out.disk = 1;
  });
  // The floppy sound follows the first drive running, else the first drive.
  const running = drives.findIndex(d => d.motorOn);
  const sounding = running >= 0 ? running : 0;
  const drive = drives[sounding];
  if (drive) {
    out.floppySlot = sounding;
    out.floppyMotor = drive.motorOn;
    out.floppyTrack = drive.currentTrack;
    out.floppyProfile = drive.model === '1581' ? 1 : 2;      // 3.5 inch, or 5.25 inch
  }
}

const hx = (v: number, digits = 2): string => (digits === 4 ? hex16(v) : hex8(v));

function dumpDrive(d: CbmDriveUnit, index: number): string {
  const c = d.cpu;
  const p = c.p;
  const flags = `${p & 0x80 ? 'N' : '-'}${p & 0x40 ? 'V' : '-'}-${p & 0x10 ? 'B' : '-'}${p & 8 ? 'D' : '-'}${p & 4 ? 'I' : '-'}${p & 2 ? 'Z' : '-'}${p & 1 ? 'C' : '-'}`;
  return [
    `Drive   Commodore ${d.model} as device ${8 + index}  (${((d.cpuHz ?? d.clockHz) / 1e6).toFixed(0)} MHz)`,
    `CPU     PC ${hx(c.pc, 4)}  A ${hx(c.a)}  X ${hx(c.x)}  Y ${hx(c.y)}  SP ${hx(c.sp)}  P ${hx(p)} ${flags}`,
    `ROM     ${d.hasRom ? 'DOS ROM loaded' : 'NO DOS ROM'}`,
    `Disk    ${d.loaded ? `${d.mediaName || 'disk'}${d.writeProtected ? ' (write protected)' : ''}${d.dirty ? ' (modified)' : ''}` : 'none'}`,
    `Head    track ${d.currentTrack}  half-track ${d.currentHalfTrack}  motor ${d.motorOn ? 'on' : 'off'}  LED ${d.ledOn ? 'on' : 'off'}${d.isWriting ? '  WRITING' : ''}`,
    `Bus     drive pulls CLK ${d.clkAsserted ? 'low' : 'high'}, DATA ${d.dataAsserted ? 'low' : 'high'}`,
    ...d.describe(),
  ].join('\n');
}

/** A chip-dump section per drive: the first is "drive", the others are named
 *  by their device number. */
export function cbmDriveChips(drives: readonly CbmDriveUnit[]): ChipSection[] {
  return drives.map((d, i) => ({
    name: i === 0 ? 'drive' : `drive${8 + i}`,
    description: `The disk drive at device ${8 + i}: its 6502, head, motor and LED, and its own chips (a 1541 has two 6522 VIAs; a 1571 adds a 6526 and a WD1770, a second head and a 2 MHz mode; a 1581 has a 6526 and a WD1770)`,
    dump: () => dumpDrive(d, i),
  }));
}
