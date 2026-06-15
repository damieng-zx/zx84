/**
 * disk-state — drive A/B signals.
 *
 * Two real concerns despite the file being thin wrappers:
 *
 *   1. **Drive A and B must be symmetric.** They share a UI component and
 *      a manager that treats them identically. If a copy/paste left one
 *      drive with a different default DriveStatus shape (e.g. track:''
 *      instead of '00') the UI would render mismatched columns and the
 *      manager's "no disk" check could subtly differ. Pinned here.
 *
 *   2. **DriveLed string union.** UI consumers branch on the led value;
 *      a typo in the literal ('seak') would silently render no LED. We
 *      pin all five values round-trip cleanly so the union is honoured.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as disk from '@/state/disk-state.ts';
import type { DriveLed, DriveStatus } from '@/state/disk-state.ts';

const DEFAULT_STATUS: DriveStatus = { led: 'off', track: '00', sector: '--', dirty: false };

afterEach(() => {
  disk.setCurrentDiskInfo(null);
  disk.setCurrentDiskName('');
  disk.setDriveAStatus({ ...DEFAULT_STATUS });
  disk.setCurrentDiskInfoB(null);
  disk.setCurrentDiskNameB('');
  disk.setDriveBStatus({ ...DEFAULT_STATUS });
  disk.setDiskInfoHtml('');
  disk.setDriveHtml('');
});

describe('disk-state — defaults', () => {
  it('drive A starts with no disk and an idle status', () => {
    expect(disk.currentDiskInfo()).toBeNull();
    expect(disk.currentDiskName()).toBe('');
    expect(disk.driveAStatus()).toEqual(DEFAULT_STATUS);
  });

  it('drive B starts with no disk and an idle status', () => {
    expect(disk.currentDiskInfoB()).toBeNull();
    expect(disk.currentDiskNameB()).toBe('');
    expect(disk.driveBStatus()).toEqual(DEFAULT_STATUS);
  });

  it('drives A and B default to IDENTICAL DriveStatus shapes', () => {
    // Same structural value, but should be distinct object references —
    // sharing one default object across both drives would mean updating
    // A also updates B.
    expect(disk.driveAStatus()).toEqual(disk.driveBStatus());
    expect(disk.driveAStatus()).not.toBe(disk.driveBStatus());
  });

  it('disk info / drive HTML start empty', () => {
    expect(disk.diskInfoHtml()).toBe('');
    expect(disk.driveHtml()).toBe('');
  });
});

describe('disk-state — DriveLed union', () => {
  it('round-trips all five documented LED values', () => {
    const all: DriveLed[] = ['off', 'motor', 'seek', 'read', 'write'];
    for (const led of all) {
      disk.setDriveAStatus({ led, track: '03', sector: '07', dirty: false });
      expect(disk.driveAStatus().led).toBe(led);
    }
  });
});

describe('disk-state — getter/setter pairing', () => {
  it('writes to drive A do not bleed into drive B', () => {
    disk.setCurrentDiskName('GAME.DSK');
    disk.setDriveAStatus({ led: 'read', track: '12', sector: '05', dirty: false });
    expect(disk.currentDiskNameB()).toBe('');
    expect(disk.driveBStatus()).toEqual(DEFAULT_STATUS);
  });

  it('writes to drive B do not bleed into drive A', () => {
    disk.setCurrentDiskNameB('BOOT.DSK');
    disk.setDriveBStatus({ led: 'write', track: '00', sector: '01', dirty: false });
    expect(disk.currentDiskName()).toBe('');
    expect(disk.driveAStatus()).toEqual(DEFAULT_STATUS);
  });

  it('every getter+setter pair works', () => {
    disk.setCurrentDiskInfo({ tracks: [] } as any);
    expect(disk.currentDiskInfo()).not.toBeNull();
    disk.setCurrentDiskName('A.dsk');
    expect(disk.currentDiskName()).toBe('A.dsk');
    disk.setCurrentDiskInfoB({ tracks: [] } as any);
    expect(disk.currentDiskInfoB()).not.toBeNull();
    disk.setCurrentDiskNameB('B.dsk');
    expect(disk.currentDiskNameB()).toBe('B.dsk');
    disk.setDiskInfoHtml('<i>info</i>');
    expect(disk.diskInfoHtml()).toBe('<i>info</i>');
    disk.setDriveHtml('<i>drive</i>');
    expect(disk.driveHtml()).toBe('<i>drive</i>');
  });
});
