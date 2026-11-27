/**
 * The host face of a floppy-disc controller core.
 *
 * The uPD765A (+3, CPC), the WD179x family (+D, Beta Disk, FDX, Plus 3, BBC
 * 1770, Einstein) and the Intel 8271 (BBC DFS, Acorn System) speak entirely
 * different register protocols — the uPD765A is command-block based, the WD179x
 * has a status/command byte plus track/sector/data registers, the 8271 has its
 * own command and parameter ports. What they *share* is the part every host
 * actually binds to: which drive is selected, whether a transfer is running and
 * whether it is a write, the head position and head number, and the media and
 * write-protect tabs behind each unit.
 *
 * That shared surface is what the frame probes read (drive LEDs, tracks,
 * sectors, the drive-sound feed), what the disk service drives (insert, eject,
 * save, protect), and what the FORMAT-refresh latch reports. Declaring it once
 * keeps eleven probes and four register-decode wrappers from each restating the
 * same dozen members, and makes the contract something a core can be checked
 * against rather than inferred from whichever members a caller happens to use.
 *
 * Register access is deliberately NOT here: it is chip-specific, and the
 * machine's `io.ts` talks to its concrete core directly on the hot path.
 *
 * Units are logical drive numbers (0-based). A controller may alias them
 * (the +3's units 2/3 are drives 0/1); every method here takes the logical
 * unit and resolves the alias itself, so callers never need to know.
 */

import type { DskImage } from '@/media/floppy/disk-image.ts';

export interface FloppyController {
  // ── Telemetry the frame probes read ───────────────────────────────────

  /** The spindle is turning (a read or write is under way, or the motor latch
   *  is held on). Drives the drive-panel LED and the drive-sound feed. */
  motorOn: boolean;

  /** A sector transfer is in flight. With `isWriting`, picks the read/write
   *  LED colour; on its own, the "busy" state. */
  readonly isExecuting: boolean;

  /** The transfer in flight is host-to-disc. */
  readonly isWriting: boolean;

  /** Sector number of the command in flight, or the last one served while the
   *  display latch is still lit (0 when idle). */
  readonly currentSector: number;

  /** Head position (cylinder) of a unit, whether or not it is selected. */
  getUnitTrack(unit: number): number;

  /** The unit last addressed — the drive-panel LED's active slot, and which
   *  drive the drive-sound feed follows. uPD765A also calls it `currentUnit`;
   *  this is the name every host reads. */
  readonly currentDrive: number;

  /** Head position of the unit last addressed (the drive-sound feed's track). */
  readonly currentTrack: number;

  // ── Media and write-protect tabs ──────────────────────────────────────

  /** Per-unit write-protect tab, indexed by logical unit. */
  readonly writeProtect: boolean[];

  /** True when a drive is wired to that unit's select line. A machine sold with
   *  one mechanism clears the rest, so drive-count probes answer honestly. */
  readonly connected: boolean[];

  /** Unit a FORMAT just completed on, or -1. Consumed (reset to -1) by the
   *  frame probe after it refreshes the disk metadata. */
  formattedUnit: number;

  insertDisk(image: DskImage, unit?: number): void;
  ejectDisk(unit?: number): void;
  getDiskImage(unit: number): DskImage | null;
  /** Written since insert/save — the drive's Save button lights. */
  isDirty(unit: number): boolean;
  clearDirty(unit: number): void;

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Per-UI-frame pump (motor timers, the display latch, index pulses). */
  tickFrame(): void;
}
