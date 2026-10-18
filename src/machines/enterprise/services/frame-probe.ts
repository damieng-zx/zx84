/**
 * EnterpriseFrameProbe — the status bar's and Memory pane's view of the
 * Enterprise.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSnapshot,
} from '@/machines/machine.ts';
import { DRIVE_PROFILE, fixedDrive } from '@/media/floppy/floppy-sound.ts';
import { hex8 } from '@/utils/hex.ts';
import type { EnterpriseMachine } from '../enterprise-machine.ts';
import { SEG_CARTRIDGE, SEG_EXDOS, SEG_HOSTFS } from '../constants.ts';

/** The EXDOS card drove 3.5" drives. */
const DRIVE = fixedDrive('3.5inch');

function segmentName(m: EnterpriseMachine, seg: number): string {
  if (seg >= m.memory.firstRamSegment) return seg >= 0xFC ? `VRAM ${hex8(seg)}` : `RAM ${hex8(seg)}`;
  if (!m.memory.segment(seg)) return `empty ${hex8(seg)}`;
  if (seg < SEG_CARTRIDGE) return `EXOS ${seg}`;
  if (seg < SEG_CARTRIDGE + 4) return `Cartridge ${seg - SEG_CARTRIDGE}`;
  if (seg === SEG_HOSTFS) return 'FILE: ROM';
  if (seg >= SEG_EXDOS && seg < SEG_EXDOS + 2) return `EXDOS ${seg - SEG_EXDOS}`;
  return `ROM ${hex8(seg)}`;
}

function memoryMap(m: EnterpriseMachine): MemoryMapSnapshot {
  const slots = [];
  for (let page = 3; page >= 0; page--) {
    const base = page * 0x4000;
    slots.push({
      range: `${hex8(base >> 8)}00-${hex8((base + 0x3FFF) >> 8)}FF`,
      read: segmentName(m, m.memory.pages[page]),
    });
  }
  const waits = ['all accesses', 'M1 only', 'none', 'none'][m.dave.waitMode];
  return {
    slots,
    registers: [
      { name: 'Wait states', value: waits },
      { name: 'LPT', value: `${hex8(m.nick.lptBase >> 8)}${hex8(m.nick.lptBase & 0xFF)}` },
      { name: 'Border', value: hex8(m.nick.border) },
    ],
  };
}

export class EnterpriseFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;

  constructor(private readonly machine: EnterpriseMachine) {
    this.panes = { memoryMap: () => memoryMap(this.machine) };
  }

  sample(out: FrameIndicators): void {
    const m = this.machine;
    out.keyboard = m.activity.kbdReads;
    out.joystick = out.mouse = out.tapeIn = 0;
    out.tapeLoad = m.activity.fileAccesses;
    out.beeper = 0;
    out.psg = m.dave.level > 0.004 ? 1 : 0;
    out.videoFx = 0;
    out.disk = m.activity.fdcAccesses;
    out.tapeTurbo = false;
    out.tapeLoaded = false;
    out.tapePlaying = out.tapePaused = out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = false;

    const card = m.exdos;
    for (let unit = 0; unit < 4; unit++) {
      if (!card) { out.driveLed[unit] = -1; continue; }
      const fdc = card.fdc;
      if (!fdc.motorOn || unit !== fdc.currentDrive) out.driveLed[unit] = 0;
      else if (!fdc.isExecuting) out.driveLed[unit] = 1;
      else out.driveLed[unit] = fdc.isWriting ? 3 : 2;
      out.driveTrack[unit] = fdc.getUnitTrack(unit);
      out.driveSector[unit] = fdc.isExecuting && unit === fdc.currentDrive ? fdc.currentSector : -1;
      out.driveDirty[unit] = fdc.isDirty(unit) ? 1 : 0;
    }
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    if (card) {
      out.floppySlot = card.fdc.currentDrive;
      out.floppyMotor = card.fdc.motorOn;
      out.floppyTrack = card.fdc.currentTrack;
      out.floppyProfile = DRIVE();
    } else {
      out.floppySlot = -1;
      out.floppyProfile = DRIVE_PROFILE.keep;
    }
  }

  frameTick(out: FrameIndicators): void {
    const fdc = this.machine.exdos?.fdc;
    if (fdc && fdc.formattedUnit >= 0) {
      out.formattedSlot = fdc.formattedUnit;
      fdc.formattedUnit = -1;
    }
  }

  diskImageForSlot(slot: number) {
    return this.machine.exdos?.fdc.getDiskImage(slot) ?? null;
  }
}
