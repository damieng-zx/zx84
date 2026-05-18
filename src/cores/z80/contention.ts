import type { Z80 } from './core.ts';

/**
 * Apply N internal-bus contention cycles at `addr`. Each cycle calls the
 * machine's contention hook and ticks one T-state. Replaces the inline
 * `for (let i = 0; i < N; i++) { this.contend(...); this.tStates += 1; }`
 * pattern that appears in every prefix dispatcher.
 */
export function contendN(cpu: Z80, addr: number, n: number): void {
  for (let i = 0; i < n; i++) {
    cpu.contend(addr);
    cpu.tStates += 1;
  }
}
