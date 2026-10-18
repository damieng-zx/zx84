/**
 * PC of each Spectrum ROM's key-wait loop, where the software library's
 * one-shot auto-boot trap injects the loader keystrokes.
 *
 * The +2A/+3 boot menu waits in ROM 0 on
 *   PUSH HL ; LD HL,FLAGS (0x5C3B) ; BIT 5,(HL) ; JR Z,-4
 * and the loop spins on the BIT/JR pair. Its address moves between ROM
 * revisions — 0x1875 in v4.0 (plus3-0.rom), 0x187A in v4.1 (plus3-41-0.rom),
 * 0x1891 in the Spanish plus3-0-es.rom — and the app loads v4.1 for both the
 * +2A and the +3 while the ROM pane can install anything. So the trap is found
 * in the installed ROM 0 itself rather than keyed off model + locale.
 */

import type { SpectrumModel } from './models.ts';
import { isPentagonClass, isScorpionClass } from './models.ts';

/** PUSH HL; LD HL,0x5C3B; BIT 5,(HL); JR Z,-4 — the +2A/+3 menu key-wait. */
const PLUS3_MENU_WAIT = [0xE5, 0x21, 0x3B, 0x5C, 0xCB, 0x6E, 0x28, 0xFC];
/** Offset of the BIT 5,(HL) the loop jumps back to. */
const PLUS3_MENU_WAIT_LOOP = 4;
/** v4.1 address, for a ROM 0 without the sequence (the app's default set). */
const PLUS3_MENU_WAIT_V41 = 0x187A;

/** Address of the +2A/+3 menu key-wait loop in `rom0`, or -1 if absent. */
export function findPlus3MenuWait(rom0: Uint8Array): number {
  const end = Math.min(rom0.length, 0x4000) - PLUS3_MENU_WAIT.length;
  outer: for (let a = 0; a <= end; a++) {
    for (let k = 0; k < PLUS3_MENU_WAIT.length; k++) {
      if (rom0[a + k] !== PLUS3_MENU_WAIT[k]) continue outer;
    }
    return a + PLUS3_MENU_WAIT_LOOP;
  }
  return -1;
}

/** Scorpion ZS-256 v2.5c address, for a ROM 0 without the sequence. */
const SCORPION_MENU_WAIT_V25C = 0x3683;

/** Trap PC for `model`: the +2A/+3 menu wait found in the installed ROM 0,
 *  the same loop in a Scorpion or Pentagon-branded ROM, the Sinclair 128K/+2
 *  menu wait, or the 48K editor's WAIT-KEY. */
export function bootWaitPc(model: SpectrumModel, rom0: Uint8Array): number {
  if (model === 'zx128kplus2a' || model === 'zx128kplus3') {
    const pc = findPlus3MenuWait(rom0);
    return pc >= 0 ? pc : PLUS3_MENU_WAIT_V41;
  }
  // The Scorpion's menu waits in the same PUSH HL / BIT 5,(HL) loop as the +3's.
  if (isScorpionClass(model)) {
    const pc = findPlus3MenuWait(rom0);
    return pc >= 0 ? pc : SCORPION_MENU_WAIT_V25C;
  }
  // A Pentagon-branded ROM (the usual 128 menu with a TR-DOS entry) waits in that
  // same loop; the Sinclair 128K ROM the Pentagons ship with does not contain it.
  if (isPentagonClass(model)) {
    const pc = findPlus3MenuWait(rom0);
    if (pc >= 0) return pc;
  }
  // Sinclair 128K/+2 menu wait.
  if (model === 'zx128k' || model === 'zx128kplus2' || isPentagonClass(model)) return 0x0E65;
  return 0x15DE;                                           // 48K editor WAIT-KEY
}
