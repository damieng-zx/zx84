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
import { state, type InitMachineOptions } from './state.ts';

function narrow<T>(kind: Machine['kind']): T | null {
  const m: Machine | undefined = state.spec;
  return m && m.kind === kind ? (m as unknown as T) : null;
}

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

// ── Headless launch knobs ─────────────────────────────────────────────
// Family-specific headless tweaks, consolidated here so state.ts stays
// machine-blind. The zx8x RAM-pack flag doubles as MCP session state: the
// model tool reports it and the library loader upgrades it.

let zx8x16k = false;

/** Whether the active ZX80/ZX81 session has the 16KB RAM pack fitted. */
export function zx8x16kRam(): boolean { return zx8x16k; }

/** Apply per-family headless knobs to a freshly created machine, before its
 *  ROM is installed and it is reset. Returns a short status fragment (the
 *  ZX80/ZX81 RAM size) for initMachine's ready line. */
export function applyHeadlessKnobs(machine: Machine, options: InitMachineOptions): string {
  zx8x16k = machine.kind === 'zx8x' ? (options.zx8x16kRam ?? false) : false;
  if (machine.kind === 'spectrum') {
    // Cheap scanline rendering — the MCP framebuffer is only read on demand.
    (machine as unknown as { scanlineAccuracy: string }).scanlineAccuracy = 'low';
  }
  if (machine.kind === 'zx8x') {
    machine.applySettings({
      get<T>(key: string, fallback: T): T {
        return key === 'zx8x-16k-ram' ? (zx8x16k as T) : fallback;
      },
    });
    return ` RAM=${zx8x16k ? '16KB' : '1KB'}`;
  }
  return '';
}
