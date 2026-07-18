/**
 * Concrete-machine access for MCP tools — THE single sanctioned module that
 * narrows the machine-blind handle to a concrete class (re-architecture §3.7).
 *
 * The generic debug tools (registers, stepping, memory, trace, breakpoints) go
 * through `state.spec.services.debug`; the tools here are genuinely machine-
 * specific (Multiface button, VTX-5000, Beta Disk paging, +3 FDC forensics,
 * keyboard matrices) and reach the concrete machine the way a bench probe
 * reaches a board. TODO(P9): fold the remaining media/peripheral tools onto
 * service seams where worthwhile; until then all concrete access funnels here.
 */

import type { Spectrum } from '../src/machines/spectrum/spectrum.ts';
import type { CpcMachine } from '../src/machines/cpc/cpc-machine.ts';
import type { MsxMachine } from '../src/machines/msx/msx-machine.ts';
import type { EinsteinMachine } from '../src/machines/einstein/einstein-machine.ts';
import type { UPD765A } from '../src/cores/upd765a.ts';
import type { Machine } from '../src/machines/machine.ts';
import { state } from './state.ts';

/** The active machine as a Spectrum, or null. Spectrum-only tools use this to
 *  bail gracefully on other machines. */
export function activeSpectrum(): Spectrum | null {
  return narrow<Spectrum>('spectrum');
}

/** The active machine as a CpcMachine, or null otherwise. */
export function activeCpc(): CpcMachine | null {
  return narrow<CpcMachine>('cpc');
}

/** The active machine as an MsxMachine, or null otherwise. */
export function activeMsx(): MsxMachine | null {
  return narrow<MsxMachine>('msx');
}

/** The active machine as an EinsteinMachine, or null otherwise. */
export function activeEinstein(): EinsteinMachine | null {
  return narrow<EinsteinMachine>('einstein');
}

/** The built-in uPD765A of the active +3/CPC, or null (sector-level tools). */
export function activeFdc(): UPD765A | null {
  return activeSpectrum()?.fdc ?? activeCpc()?.fdc ?? null;
}

function narrow<T>(kind: Machine['kind']): T | null {
  const m: Machine | undefined = state.spec;
  return m && m.kind === kind ? (m as unknown as T) : null;
}
