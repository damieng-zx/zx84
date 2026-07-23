/**
 * Machine registry — the parts catalog (re-architecture §3.5).
 *
 * This file and `src/models.ts` are the ONLY places allowed to name every
 * machine. Everything else reaches machines through a `MachineEntry` looked up
 * here, or through the `Machine` interface. Adding machine #5 means: create
 * `src/machines/<name>/` with a `descriptor.ts`, add one import + one array
 * entry here, and extend the model union in `src/models.ts` — nothing else.
 *
 * Must stay importable headless (Node / MCP / tests): descriptors and the
 * machine classes they construct never import solid-js or reactive state
 * (enforced by the `machines-no-ui` dependency-cruiser rule).
 */

import type { MachineEntry, MachineKind } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { spectrumEntry } from '@/machines/spectrum/descriptor.ts';
import { cpcEntry } from '@/machines/cpc/descriptor.ts';
import { einsteinEntry } from '@/machines/einstein/descriptor.ts';
import { msxEntry } from '@/machines/msx/descriptor.ts';
import { zx8xEntry } from '@/machines/zx8x/descriptor.ts';

export const registry: readonly MachineEntry[] = [
  spectrumEntry,
  cpcEntry,
  einsteinEntry,
  msxEntry,
  zx8xEntry,
];

/** The registry entry owning `model`. Throws on an unknown model — every
 *  `MachineModel` union member must appear in exactly one entry's list. */
export function entryForModel(model: MachineModel): MachineEntry {
  for (const entry of registry) {
    if ((entry.models as readonly string[]).includes(model)) return entry;
  }
  throw new Error(`No machine registered for model '${model}'`);
}

/** The registry entry for a machine kind, or null if none is registered. */
export function entryForKind(kind: MachineKind): MachineEntry | null {
  return registry.find(e => e.kind === kind) ?? null;
}
