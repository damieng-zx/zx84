import type { Machine, MachineKind } from '@/machines/machine.ts';

/**
 * Narrow the shell's machine-blind handle to one concrete machine class, or
 * null when `m` is absent or another kind is running.
 *
 * A machine's own `ui/active.ts` calls this with the shell's live `machine`
 * binding — the shell context can't be imported from here, since only `ui/`
 * modules may reach it.
 */
export function narrowMachine<T extends Machine>(m: Machine | null, kind: MachineKind): T | null {
  return m !== null && m.kind === kind ? (m as T) : null;
}
