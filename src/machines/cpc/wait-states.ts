import type { Z80 } from '@/cores/z80.ts';

/**
 * CPC Gate Array /WAIT (READY) model — the "everything is a multiple of 1µs"
 * rule, expressed per Z80 machine cycle.
 *
 * The Gate Array shares RAM between the Z80 and the video fetch on a fixed
 * 1µs (4 T-state) cycle, and drives the Z80's /WAIT input low for 3 of every 4
 * CPU clocks. The Z80 only samples /WAIT at one point in a machine cycle, and
 * only in cycles that drive the bus:
 *
 *   cycle type                 /WAIT sampled at     cycle must start at phase
 *   M1 fetch / memory read/wr  T2                   0
 *   I/O read / write           TW (3rd clock)       3
 *   interrupt acknowledge      2nd auto-TW (4th)    2
 *
 * (phase = T-state mod 4, with 0 = the clock whose T2 lands on the one READY
 * clock of the µs). A cycle that would start off-phase is held in wait states
 * until it lines up; internal (non-bus) cycles are never stretched. Applying
 * this to the Z80's per-cycle breakdown reproduces the published CPC "NOP"
 * timing table for every instruction — e.g. PUSH rr 11T → 4µs (5T M1 then two
 * aligned writes), EX (SP),HL 19T → 6µs, OUT (C),r 12T → 4µs, CPI 16T → 4µs,
 * IM 1 acknowledge 13T → 5µs (4µs after an instruction ending in internal
 * cycles, Caprice32's `iWSAdjust`).
 *
 * The same rule is used by MAME (`amstrad_cpc_mem_r/w` round each access up
 * to a 4-cycle boundary) and floooh's chips (`am40010_tick` READY = 3 of 4).
 *
 * The CPC's memory and port hooks call these on every bus cycle. Each returns
 * the (possibly stretched) T-state at which the cycle actually proceeds.
 * T-state counts are cumulative doubles that exceed 2^32 in long sessions, so
 * only the low two bits are taken with `&` (ToInt32 is modulo 2^32, which
 * preserves them) — never `t & ~3`.
 */

/** Memory cycle (M1 fetch, memory read or write) called at its T1. */
export function cpcMemCycleStart(t: number): number {
  return t + ((-t) & 3);
}

/** I/O write: the core calls `portOut` at the I/O cycle's T1. */
export function cpcIoOutStart(t: number): number {
  return t + ((3 - t) & 3);
}

/** I/O read: the core calls `portIn` 3T into the I/O cycle (T1 at t-3, the
 *  sample lands late in the cycle), so T1 must be at phase 3 → t at phase 2. */
export function cpcIoInSample(t: number): number {
  return t + ((2 - t) & 3);
}

/** Interrupt acknowledge (M1 + IORQ) cycle start. */
export function cpcIntAckStart(t: number): number {
  return t + ((2 - t) & 3);
}

/**
 * Accept a maskable interrupt on the CPC: hold the acknowledge cycle for the
 * Gate Array's /WAIT, then run the Z80's acknowledge (its stack pushes and IM 2
 * vector read align in the memory hooks). `vector` < 0 = the plain ack (the
 * CPC data bus floats to 0xFF); otherwise the Plus ASIC's vector byte.
 * Caller has already checked IFF1 / the EI shadow. Returns interrupt()'s
 * base T-state count (0 if not accepted).
 */
export function cpcAcknowledgeInterrupt(cpu: Z80, vector: number): number {
  cpu.tStates = cpcIntAckStart(cpu.tStates);
  return vector < 0 ? cpu.interrupt() : cpu.interruptWithVector(vector);
}
