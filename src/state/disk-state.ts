/**
 * Disk State - floppy disk status signals.
 *
 * Tracks disk images loaded in drive A and B:
 * - Disk info (geometry, tracks, sectors)
 * - Disk names
 * - Drive status
 */

import { createSignal } from 'solid-js';
import type { DskImage } from '@/media/floppy/disk-image.ts';

export type DriveLed = 'off' | 'motor' | 'seek' | 'read' | 'write';

export interface DriveStatus {
  led: DriveLed;
  track: string;
  sector: string;
  /** Disk has unsaved writes since it was inserted/saved (lights the Save button). */
  dirty: boolean;
}

// Drive A
const _currentDiskInfo = createSignal<DskImage | null>(null);
export const currentDiskInfo = _currentDiskInfo[0];
export const setCurrentDiskInfo = _currentDiskInfo[1];

const _currentDiskName = createSignal('');
export const currentDiskName = _currentDiskName[0];
export const setCurrentDiskName = _currentDiskName[1];

const _driveAStatus = createSignal<DriveStatus>({ led: 'off', track: '00', sector: '--', dirty: false });
export const driveAStatus = _driveAStatus[0];
export const setDriveAStatus = _driveAStatus[1];

// Active side of a flippy disk in drive A: 0 = Side A, 1 = Side B.
const _diskSideA = createSignal(0);
export const diskSideA = _diskSideA[0];
export const setDiskSideA = _diskSideA[1];

// Drive B
const _currentDiskInfoB = createSignal<DskImage | null>(null);
export const currentDiskInfoB = _currentDiskInfoB[0];
export const setCurrentDiskInfoB = _currentDiskInfoB[1];

const _currentDiskNameB = createSignal('');
export const currentDiskNameB = _currentDiskNameB[0];
export const setCurrentDiskNameB = _currentDiskNameB[1];

const _driveBStatus = createSignal<DriveStatus>({ led: 'off', track: '00', sector: '--', dirty: false });
export const driveBStatus = _driveBStatus[0];
export const setDriveBStatus = _driveBStatus[1];

// Active side of a flippy disk in drive B: 0 = Side A, 1 = Side B.
const _diskSideB = createSignal(0);
export const diskSideB = _diskSideB[0];
export const setDiskSideB = _diskSideB[1];

// MGT +D drives C and D (WD1772). Separate from the +3's A/B so a +D session
// and a +3 session never share signals.
const _currentDiskInfoC = createSignal<DskImage | null>(null);
export const currentDiskInfoC = _currentDiskInfoC[0];
export const setCurrentDiskInfoC = _currentDiskInfoC[1];

const _currentDiskNameC = createSignal('');
export const currentDiskNameC = _currentDiskNameC[0];
export const setCurrentDiskNameC = _currentDiskNameC[1];

const _driveCStatus = createSignal<DriveStatus>({ led: 'off', track: '00', sector: '--', dirty: false });
export const driveCStatus = _driveCStatus[0];
export const setDriveCStatus = _driveCStatus[1];

const _currentDiskInfoD = createSignal<DskImage | null>(null);
export const currentDiskInfoD = _currentDiskInfoD[0];
export const setCurrentDiskInfoD = _currentDiskInfoD[1];

const _currentDiskNameD = createSignal('');
export const currentDiskNameD = _currentDiskNameD[0];
export const setCurrentDiskNameD = _currentDiskNameD[1];

const _driveDStatus = createSignal<DriveStatus>({ led: 'off', track: '00', sector: '--', dirty: false });
export const driveDStatus = _driveDStatus[0];
export const setDriveDStatus = _driveDStatus[1];

// Disk info HTML (for UI display)
const _diskInfoHtml = createSignal('');
export const diskInfoHtml = _diskInfoHtml[0];
export const setDiskInfoHtml = _diskInfoHtml[1];

const _driveHtml = createSignal('');
export const driveHtml = _driveHtml[0];
export const setDriveHtml = _driveHtml[1];
