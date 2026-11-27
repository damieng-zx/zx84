/**
 * Machine registry — the parts catalog.
 *
 * This file and `src/models.ts` are the ONLY places allowed to name every
 * machine. Everything else reaches machines through a `MachineEntry` looked up
 * here, or through the `Machine` interface.
 *
 * Adding a machine means: create `src/machines/<name>/` with a `descriptor.ts`
 * exporting an entry whose `models` is a literal list of that machine's model
 * ids, add one import + one array entry here, and add the family's model type
 * and union member to `src/models.ts`. The declarations below prove at compile
 * time that this catalog, the `MachineKind` union and the `MachineModel` union
 * say exactly the same thing, so a model added to one and forgotten in the
 * others fails `tsc` rather than shipping an unlaunchable id.
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
import { mtxEntry } from '@/machines/mtx/descriptor.ts';
import { lynxEntry } from '@/machines/lynx/descriptor.ts';
import { aceEntry } from '@/machines/jupiter-ace/descriptor.ts';
import { pcwEntry } from '@/machines/pcw/descriptor.ts';
import { bbcEntry } from '@/machines/bbc/descriptor.ts';
import { electronEntry } from '@/machines/electron/descriptor.ts';
import { acornSystemEntry } from '@/machines/acorn-system/descriptor.ts';
import { apple2Entry } from '@/machines/apple2/descriptor.ts';
import { apple1Entry } from '@/machines/apple1/descriptor.ts';
import { enterpriseEntry } from '@/machines/enterprise/descriptor.ts';
import { atariEntry } from '@/machines/atari/descriptor.ts';
import { c64Entry } from '@/machines/c64/descriptor.ts';
import { vic20Entry } from '@/machines/vic20/descriptor.ts';
import { c128Entry } from '@/machines/c128/descriptor.ts';
import { oricEntry } from '@/machines/oric/descriptor.ts';
import { atomEntry } from '@/machines/atom/descriptor.ts';
import { plus4Entry } from '@/machines/plus4/descriptor.ts';

/**
 * The catalog in literal form. `as const satisfies` keeps each entry's own type
 * (so `kind` and `models` stay narrow enough to compare against the SPI unions
 * below) while still rejecting an entry that does not honour `MachineEntry`.
 */
const entries = [
  spectrumEntry,
  cpcEntry,
  einsteinEntry,
  msxEntry,
  zx8xEntry,
  mtxEntry,
  lynxEntry,
  aceEntry,
  pcwEntry,
  bbcEntry,
  electronEntry,
  acornSystemEntry,
  apple2Entry,
  apple1Entry,
  enterpriseEntry,
  atariEntry,
  c64Entry,
  vic20Entry,
  c128Entry,
  atomEntry,
  oricEntry,
  plus4Entry,
] as const satisfies readonly MachineEntry[];

/** The parts catalog every consumer binds to. */
export const registry: readonly MachineEntry[] = entries;

// ── Compile-time agreement with the SPI unions ─────────────────────────────
//
// Two facts have to hold and both are easy to break silently:
//   1. every `MachineModel` is owned by exactly one entry's `models` list, and
//   2. every `MachineKind` is exactly one entry's `kind`.
// A missing model 404s at `entryForModel`; a missing kind leaves `entryForKind`
// returning null where a caller assumed a machine exists. These aliases make
// either a type error instead: `Expect` only accepts `true`, and `AssertEqual`
// yields `never` when the two unions differ in either direction.

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type Expect<T extends true> = T;

type RegistryModel = (typeof entries)[number]['models'][number];
type RegistryKind = (typeof entries)[number]['kind'];

/** Type-level proof that the registry covers `MachineModel` and nothing else. */
export type RegistryCoversModels = Expect<AssertEqual<RegistryModel, MachineModel>>;
/** Type-level proof that the registry covers `MachineKind` and nothing else. */
export type RegistryCoversKinds = Expect<AssertEqual<RegistryKind, MachineKind>>;

/**
 * Forces `tsc` to evaluate both proofs. A type alias nobody references is never
 * expanded, so the proof would otherwise be silently vacuous; annotating a value
 * with it makes a divergence from `MachineModel`/`MachineKind` a hard error.
 * Exported so it is not an unused local; the value itself is never read.
 */
export const registryAgreesWithSpi: RegistryCoversModels & RegistryCoversKinds = true;

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
