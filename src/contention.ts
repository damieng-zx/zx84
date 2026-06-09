/**
 * ULA contention timing and floating bus emulation.
 *
 * On real hardware the ULA and CPU share the same memory bus. During the
 * 128 T-states of each visible scanline the ULA fetches pixel/attribute data,
 * stalling the CPU whenever it tries to access contended memory. The delay
 * depends on which sub-cycle of the ULA's 8-T-state fetch pattern the access
 * falls on.
 */

import type { MachineVariant } from '@/variants/machine-variant.ts';
import type { SpectrumMemory } from '@/memory.ts';
import { vramBitmapAddr, vramAttrAddr, DISPLAY_HEIGHT } from '@/cores/ula.ts';

// ── CPU clock (Hz) ──────────────────────────────────────────────────────
/** 48K Z80 clock: 3.5 MHz. */
export const Z80_CLOCK_48K = 3_500_000;
/** 128K / +2 / +2A / +3 Z80 clock: ~3.5469 MHz (derived from 17.7345 MHz / 5). */
export const Z80_CLOCK_128K = 3_546_900;

// ── Frame timing (T-states per frame) ───────────────────────────────────
/** 48K: 224 T-states/line × 312 lines. */
export const TSTATES_PER_FRAME_48K = 69_888;
/** 128K/+2/+2A/+3: 228 T-states/line × 311 lines. */
export const TSTATES_PER_FRAME_128K = 70_908;

/** Model-dependent ULA timing parameters. */
export interface MachineTiming {
  cpuClock: number;
  tStatesPerFrame: number;
  tStatesPerLine: number;
  /** Frame-relative T-state at which contention begins (first ULA fetch). */
  contentionStart: number;
  /** Frame-relative T-state of the first display pixel output.
   *  For 48K: 16 vertical-retrace + 48 top-border lines = 64 × 224 = 14336.
   *  May differ from contentionStart because the ULA fetch starts before
   *  pixel output on some models. */
  displayOrigin: number;
  /** How many T-states INT is held LOW at frame start. */
  intLength: number;
  /** Floating bus read offset: −1 for 48K, +1 for 128K+. */
  floatingBusAdjust: number;
}

export const TIMING_48K: MachineTiming = {
  cpuClock: Z80_CLOCK_48K,
  tStatesPerFrame: TSTATES_PER_FRAME_48K,   // 224 × 312
  tStatesPerLine: 224,
  contentionStart: 14335,
  displayOrigin: 14336,     // 64 lines × 224 (8 VBlank + 56 border)
  intLength: 32,
  floatingBusAdjust: -1,
};

export const TIMING_128K: MachineTiming = {
  cpuClock: Z80_CLOCK_128K,
  tStatesPerFrame: TSTATES_PER_FRAME_128K,  // 228 × 311
  tStatesPerLine: 228,
  contentionStart: 14361,
  // First pixel: contentionStart + 1T, same lead as the 48K's 14335→14336.
  // The Sinclair wiki claims 14364 (63 lines × 228), but azesmbog's
  // real-hardware ULA128 timing test is calibrated to 14361/14362 — emulators
  // tuned to pass it (ESPectrum TS_SCREEN_128=14361 vs TS_SCREEN_48=14335,
  // a +26 model delta) confirm the +1 relationship, not +3.
  displayOrigin: 14362,
  intLength: 36,
  floatingBusAdjust: 1,
};

export const TIMING_PLUS2A: MachineTiming = {
  cpuClock: Z80_CLOCK_128K,
  tStatesPerFrame: TSTATES_PER_FRAME_128K,  // 228 × 311
  tStatesPerLine: 228,
  contentionStart: 14361,   // Amstrad ASIC ULA fetch starts here
  displayOrigin: 14364,     // first pixel output (contentionStart + 3T pipeline)
  intLength: 32,
  floatingBusAdjust: 1,
};

export class Contention {
  readonly timing: MachineTiming;
  private variant: MachineVariant;
  private memory: SpectrumMemory;

  /** T-state counter at start of current frame (set by Spectrum each frame). */
  frameStartTStates = 0;

  /** Cached per-slot contention status. slotContended[slot] is 1 when the
   *  current bank in that 16KB slot is contended, 0 otherwise. Refreshed
   *  on every paging change via refreshSlotMask(); collapses the
   *  isContended -> bankAt -> variant.isContended chain (with virtual
   *  dispatch through the variant strategy) to a single array load on
   *  every memory access. */
  readonly slotContended = new Uint8Array(4);

  constructor(variant: MachineVariant, memory: SpectrumMemory) {
    this.variant = variant;
    this.memory = memory;
    this.timing = variant.timing;
    // Own the paging change subscription so the slot cache stays exact
    // even when Contention is used standalone (e.g. unit tests).
    memory.onSlotsChanged = () => this.refreshSlotMask();
    this.refreshSlotMask();
  }

  /** Recompute slotContended from the variant + current bank mapping.
   *  Called by SpectrumMemory whenever slots change (bank switch, special
   *  paging toggle, ROM swap). The variant.isContended check is sub-bank
   *  on some models (e.g. Frontier's odd-bank contention) but every model
   *  in our matrix gives the same answer for any address within a slot,
   *  so caching per-slot is exact. */
  refreshSlotMask(): void {
    const m = this.slotContended;
    const v = this.variant;
    // One representative address per slot is enough — variant.isContended
    // depends only on (slot, bank), not on the offset within the slot.
    m[0] = v.isContended(0x0000, this.memory.bankAt(0x0000)) ? 1 : 0;
    m[1] = v.isContended(0x4000, this.memory.bankAt(0x4000)) ? 1 : 0;
    m[2] = v.isContended(0x8000, this.memory.bankAt(0x8000)) ? 1 : 0;
    m[3] = v.isContended(0xC000, this.memory.bankAt(0xC000)) ? 1 : 0;
  }

  /** True if the given address is in ULA-contended memory. */
  isContended(addr: number): boolean {
    return this.slotContended[addr >>> 14] !== 0;
  }

  /** Returns the contention delay (extra T-states) for the current beam position. */
  contentionDelay(cpuTStates: number): number {
    const t = this.timing;
    const frameTStates = cpuTStates - this.frameStartTStates;
    const offset = frameTStates - t.contentionStart;
    if (offset < 0) return 0;
    const line = (offset / t.tStatesPerLine) | 0;
    if (line >= DISPLAY_HEIGHT) return 0;
    const col = offset - line * t.tStatesPerLine;
    if (col >= 128) return 0;
    return this.variant.contentionPattern[col & 7];
  }

  /**
   * Apply I/O contention for port access.
   * On real hardware, the ULA applies contention during I/O cycles based on
   * whether the port address high byte is contended and whether it's a ULA port.
   *
   * Patterns (C = contention delay, N = none, number = sub-cycle T-states):
   *   Contended + ULA (A0=0): C:1, C:3  —  2 contention checks
   *   Contended + non-ULA:    C:1, C:1, C:1, C:1  —  4 checks
   *   Non-contended + ULA:    N:1, C:3  —  1 check
   *   Non-contended + non-ULA: N:4  —  no contention
   *
   * The probe positions walk forward from the START of the IORQ cycle.
   * `offsetIntoCycle` is how far into the cycle the caller's tStates already
   * is: OUTs invoke the port handler at cycle start (0), INs invoke it 3T in
   * (the late sample point tape edge loaders need), so the probes must be
   * anchored back at tStates - 3. Only the contention extras are added to
   * cpu.tStates — the base 4T of the IO cycle stay in the instruction timing.
   */
  applyIOContention(port: number, cpu: { tStates: number }, offsetIntoCycle = 0): void {
    if (!this.variant.hasIOContention) {
      // Amstrad gate array (+2A/+3): no I/O contention.
      // The gate array only applies contention when MREQ is active,
      // and MREQ is not asserted during I/O operations (IORQ instead).
      return;
    }

    // 48K / 128K / +2 (Ferranti ULA): four-case I/O contention
    const isULA = (port & 1) === 0;
    const highContended = this.isContended(port);
    const start = cpu.tStates - offsetIntoCycle;
    let pos = start;

    if (highContended && isULA) {
      // C:1, C:3
      pos += this.contentionDelay(pos);
      pos += 1;
      pos += this.contentionDelay(pos);
      pos -= 1;
    } else if (highContended) {
      // C:1, C:1, C:1, C:1
      pos += this.contentionDelay(pos);
      pos += 1;
      pos += this.contentionDelay(pos);
      pos += 1;
      pos += this.contentionDelay(pos);
      pos += 1;
      pos += this.contentionDelay(pos);
      pos -= 3;
    } else if (isULA) {
      // N:1, C:3
      pos += 1;
      pos += this.contentionDelay(pos);
      pos -= 1;
    }
    cpu.tStates += pos - start;
  }

  /**
   * Floating bus read: returns whatever the ULA is currently fetching from VRAM.
   * During active display, this is a pixel byte or attribute byte.
   * Outside active display, returns 0xFF.
   * @param screenBank 16KB bank array for the current screen (bank 5 or 7).
   */
  floatingBusRead(cpuTStates: number, screenBank: Uint8Array): number {
    const t = this.timing;
    const frameTStates = cpuTStates - this.frameStartTStates;
    const offset = frameTStates - t.contentionStart + t.floatingBusAdjust;
    if (offset < 0) return 0xFF;
    const line = (offset / t.tStatesPerLine) | 0;
    if (line >= DISPLAY_HEIGHT) return 0xFF;
    const col = offset - line * t.tStatesPerLine;
    if (col >= 128) return 0xFF;

    // Measured ULA fetch sequence per 8T block (FUSE / Sinclair Wiki): the
    // ULA fetches two character columns in the first 4 T-states —
    //   pixel n, attr n, pixel n+1, attr n+1 —
    // then releases the bus for the remaining 4 T-states (reads as 0xFF).
    // Addresses from vramBitmapAddr/vramAttrAddr are 64K-space; subtract 0x4000
    // because screenBank is indexed from 0 within the 16KB bank.
    const phase = col & 7;
    if (phase >= 4) return 0xFF;  // bus idle half of the block
    const charCol = ((col >> 3) << 1) | (phase >> 1);

    if (phase & 1) {
      return screenBank[vramAttrAddr(line, charCol) - 0x4000];     // Attribute byte
    } else {
      return screenBank[vramBitmapAddr(line) - 0x4000 + charCol];  // Pixel byte
    }
  }
}
