/**
 * SAM FrameProbe — maps the machine's per-frame activity counters onto the
 * generic FrameIndicators channels, and hosts the memory-layout pane.
 *
 * `sample()` is a tier-3 hot path: it overwrites the shared struct in place and
 * must not allocate. `panes.memoryMap()` is pull-on-demand and may allocate
 * freely.
 *
 * The tape transport channels stay absent (the bridge then leaves those
 * signals alone) until the cassette deck is fitted.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSlot, MemoryMapSnapshot,
} from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { SamMachine } from '../sam-machine.ts';
import type { SamSectionSource } from '../sam-memory.ts';
import { hex8 } from '@/utils/hex.ts';

/** Human label for what a section's CPU reads resolve to. */
function sourceLabel(src: SamSectionSource): string {
  switch (src.kind) {
    case 'rom': return `ROM ${src.index}`;
    case 'ram': return `RAM ${src.page}`;
    case 'external': return `EXT ${src.page}`;
    case 'absent': return '(open bus)';
  }
}

/**
 * Build the SAM memory-layout snapshot. Like the CPC — and unlike the
 * Spectrum — reads and writes can differ (ROM overlay, write-protection), so
 * each 16K section shows both.
 */
function samMemoryMap(m: SamMachine): MemoryMapSnapshot {
  const p = m.memory.pagingState();
  const ranges = ['C000-FFFF', '8000-BFFF', '4000-7FFF', '0000-3FFF'];

  const slots: MemoryMapSlot[] = ranges.map((range, row) => {
    const section = 3 - row;
    const src = p.sections[section];
    const read = sourceLabel(src);
    // The display fetch reads internal RAM directly and ignores CPU paging, so
    // flag a section only when the page it holds *is* a display page.
    const isScreen = src.kind === 'ram'
      && (src.page === p.videoPage
        || (p.videoMode >= 3 && src.page === p.videoPage + 1));
    return {
      range,
      read,
      write: p.readOnly[section] ? '(protected)' : read,
      flags: isScreen ? (['screen'] as const) : undefined,
    };
  });

  return {
    columns: ['CPU read', 'CPU write'],
    slots,
    registers: [
      { name: 'LMPR', value: hex8(p.lmpr) },
      { name: 'HMPR', value: hex8(p.hmpr) },
      { name: 'VMPR', value: hex8(p.vmpr) },
      { name: 'LEPR', value: hex8(p.lepr) },
      { name: 'HEPR', value: hex8(p.hepr) },
      { name: 'Mode', value: String(p.videoMode) },
      { name: 'WProt', value: p.writeProtected ? 'Y' : 'N' },
    ],
  };
}

export class SamFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;

  constructor(private readonly m: SamMachine) {
    this.panes = { memoryMap: () => samMemoryMap(m) };
  }

  sample(out: FrameIndicators): void {
    const a = this.m.activity;

    out.keyboard = a.kbdReads;
    out.joystick = a.joystickReads;
    out.mouse = 0;
    out.tapeIn = a.tapeReads;
    out.tapeLoad = 0;
    out.beeper = a.beeperWrites;
    out.psg = a.psgWrites > 5 ? 1 : 0;
    // Mid-frame palette and border writes are what drive the SAM's raster
    // colour effects, so they are what the "rainbow" indicator reports.
    out.videoFx = this.m.asic.midLineWrites;
    out.disk = a.fdcAccesses;
    out.tapeTurbo = false;

    out.tapeLoaded = false;
    out.tapePlaying = false;
    out.tapePaused = true;
    out.tapeFinished = false;
    out.tapePosition = 0;
    out.casBlock = -1;
    out.fastRomLoading = false;
    out.tracingActive = false;

    // Drive panel slots 0/1 are the two internal drives; 2/3 are absent.
    const disk = this.m.disk;
    let soundSlot = -1;
    for (let u = 0; u < 2; u++) {
      const fdc = disk.fdc[u];
      const motor = fdc.motorOn;
      out.driveLed[u] = !motor ? 0
        : fdc.isWriting ? 3
        : fdc.isExecuting ? 2
        : 1;
      out.driveTrack[u] = fdc.getUnitTrack(0);
      out.driveSector[u] = fdc.currentSector;
      out.driveDirty[u] = fdc.isDirty(0) ? 1 : 0;
      if (motor && soundSlot < 0) soundSlot = u;
    }
    out.driveLed[2] = out.driveLed[3] = -1;

    out.mdvCount = 0;
    out.mdvMotorMask = 0;

    // Drive-sound feed: the SAM's drives are 3.5" (profile 1).
    out.floppySlot = soundSlot;
    out.floppyMotor = soundSlot >= 0;
    out.floppyTrack = soundSlot >= 0 ? disk.track(soundSlot) : 0;
    out.floppyProfile = 1;
  }

  /** Per-UI-frame device bookkeeping: the controllers' own frame ticks. */
  frameTick(): void {
    this.m.disk.frameTick();
  }

  /** Live image in a drive panel slot, for the post-format metadata refresh. */
  diskImageForSlot(slot: number): DskImage | null {
    return slot < 2 ? this.m.disk.image(slot) : null;
  }
}
