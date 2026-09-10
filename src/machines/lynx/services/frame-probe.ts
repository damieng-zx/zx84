/**
 * LynxFrameProbe — the status bar's and Memory pane's view of the Lynx.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSnapshot,
} from '@/machines/machine.ts';
import { hex8 } from '@/utils/hex.ts';
import type { LynxMachine } from '../lynx-machine.ts';

/** What a page number means, for the memory-layout pane. Pages 0-7 are the
 *  ROM region, 8-15 user RAM, and the rest video or the 128K's extra RAM. */
function pageName(page: number, is128k: boolean): string {
  if (page < 8) return `ROM ${page}`;
  if (page < 16) return `RAM ${page - 8}`;
  if (is128k) {
    if (page < 24) return `Video ${page - 16}`;
    return `RAM ${page - 24 + 8}`;
  }
  return `Video ${page - 16}`;
}

function lynxMemoryMap(m: LynxMachine): MemoryMapSnapshot {
  const pages = m.memory.pages;
  const is128k = m.memory.is128k;
  const slots = [];
  for (let slot = 7; slot >= 0; slot--) {
    const base = slot * 0x2000;
    slots.push({
      range: `${hex8(base >> 8)}00-${hex8(((base + 0x1fff) >> 8) & 0xff)}FF`,
      read: pageName(pages[slot], is128k),
    });
  }

  // Every write goes to all the banks the enables allow, so the pane lists
  // them as one set rather than per slot.
  const w = m.memory.writeEnables;
  const banks: string[] = [];
  if (w & 0x01) banks.push('RAM');
  if ((w & 0x22) === 0x02) banks.push(is128k ? 'video' : 'blue/red');
  if ((w & 0x44) === 0x04) banks.push(is128k ? 'bank 3' : 'green');
  if (is128k && (w & 0x08)) banks.push('extra RAM');

  return {
    slots,
    registers: [
      { name: 'Writes to', value: banks.length > 0 ? banks.join(' + ') : 'nothing' },
      { name: 'Green plane', value: m.video.altGreen ? 'alternate' : 'main' },
      { name: 'Cassette', value: m.tapeMotorOn ? 'motor on' : 'motor off' },
    ],
  };
}

export class LynxFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;

  constructor(private readonly machine: LynxMachine) {
    this.panes = { memoryMap: () => lynxMemoryMap(this.machine) };
  }

  sample(out: FrameIndicators): void {
    const m = this.machine;
    out.keyboard = m.activity.kbdReads;
    out.joystick = out.mouse = out.tapeIn = 0;
    out.tapeLoad = m.activity.casReads;
    // The DAC drives the mixer's beeper channel, so that is the LED it lights.
    out.beeper = m.dacLevel;
    out.psg = 0;
    out.videoFx = 0;
    out.disk = m.activity.fdcAccesses;
    const tape = m.tape;
    out.tapeTurbo = m.tapeTurboActive;
    out.tapeLoaded = tape.blocks.length > 0;
    out.tapePlaying = tape.playing && !tape.paused;
    out.tapePaused = tape.paused;
    out.tapeFinished = tape.finished;
    out.tapePosition = tape.position;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = false;

    const fdc = m.fdc;
    for (let unit = 0; unit < 4; unit++) {
      if (!m.hasDisk || unit >= 2) { out.driveLed[unit] = -1; continue; }
      if (!fdc.motorOn || unit !== fdc.currentDrive) out.driveLed[unit] = 0;
      else if (!fdc.isExecuting) out.driveLed[unit] = 1;
      else out.driveLed[unit] = fdc.isWriting ? 3 : 2;
      out.driveTrack[unit] = fdc.getUnitTrack(unit);
      out.driveSector[unit] = fdc.isExecuting && unit === fdc.currentDrive ? fdc.currentSector : -1;
      out.driveDirty[unit] = fdc.isDirty(unit) ? 1 : 0;
    }
    out.mdvCount = 0;
    out.mdvMotorMask = 0;
    out.floppySlot = -1;
    out.floppyProfile = -1;
  }

  diskImageForSlot(slot: number) {
    return this.machine.hasDisk && slot < 2 ? this.machine.fdc.getDiskImage(slot) : null;
  }
}
