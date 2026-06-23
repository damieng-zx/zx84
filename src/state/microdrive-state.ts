/**
 * Reactive UI state for the ZX Interface 1 microdrives.
 *
 * Eight drives, each a small descriptor (loaded? / cartridge name / write
 * protect). Mirrors the per-frame activity flag the disk drives expose so the
 * status bar can show a microdrive LED. Kept as plain Solid signals to match
 * the rest of `src/state/`.
 */

import { createSignal } from 'solid-js';

export interface MicrodriveSlot {
  loaded: boolean;
  name: string;
  writeProtected: boolean;
  modified: boolean;
}

function blank(): MicrodriveSlot {
  return { loaded: false, name: '', writeProtected: false, modified: false };
}

const _slots = createSignal<MicrodriveSlot[]>(Array.from({ length: 8 }, blank));
export const microdriveSlots = _slots[0];
const setSlots = _slots[1];

/** Replace one drive's descriptor (merging the given fields). */
export function setMicrodriveSlot(unit: number, patch: Partial<MicrodriveSlot>): void {
  setSlots((prev) => prev.map((s, i) => (i === unit ? { ...s, ...patch } : s)));
}

/** Clear one drive back to empty. */
export function clearMicrodriveSlot(unit: number): void {
  setSlots((prev) => prev.map((s, i) => (i === unit ? blank() : s)));
}

/** Per-drive motor state (true while the drive is selected/spinning). Updated
 *  each frame from the emulator so the pane LED reflects the motor, not the
 *  mere presence of a cartridge. */
const _motors = createSignal<boolean[]>(new Array(8).fill(false));
export const microdriveMotors = _motors[0];
export const setMicrodriveMotors = _motors[1];

/** How many drives the pane shows (1-8). All eight are always emulated; this is
 *  purely a UI choice, persisted so it survives a reload. */
function loadCount(): number {
  try {
    const v = parseInt(localStorage.getItem('zx84-microdrive-count') || '1', 10);
    if (v >= 1 && v <= 8) return v;
  } catch { /* localStorage unavailable (tests/SSR) */ }
  return 1;
}
const _count = createSignal<number>(loadCount());
export const microdriveCount = _count[0];
export function setMicrodriveCount(n: number): void {
  const c = Math.min(8, Math.max(1, n));
  _count[1](c);
  try { localStorage.setItem('zx84-microdrive-count', String(c)); } catch { /* ignore */ }
}
