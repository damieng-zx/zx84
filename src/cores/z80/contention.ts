import type { Z80 } from './core.ts';

/**
 * Apply N internal-bus contention cycles at `addr`. Each cycle calls the
 * machine's contention hook and ticks one T-state. Replaces the inline
 * `for (let i = 0; i < N; i++) { this.contend(...); this.tStates += 1; }`
 * pattern that appears in every prefix dispatcher.
 */
export function contendN(cpu: Z80, addr: number, n: number): void {
  // Turbo mode (accurateTiming=false) — cpu.contend is a closure that would
  // short-circuit internally, but Firefox can't inline through the assigned
  // closure indirection, so the N dispatches dominate the hot path. Skip them.
  if (!cpu.accurateTiming) { cpu.tStates += n; return; }
  for (let i = 0; i < n; i++) {
    cpu.contend(addr);
    cpu.tStates += 1;
  }
}
