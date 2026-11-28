/**
 * Machine registry — the parts catalog.
 *
 * `src/models.ts` owns the `MachineModel` union; this file owns exactly one
 * entry per `MachineKind` and the literal list of models each entry can build.
 * The declarations below prove at compile time that the catalog, the
 * `MachineKind` union and the `MachineModel` union say exactly the same thing,
 * and that no model or kind is claimed twice, so a model added to one and
 * forgotten in another fails `tsc` rather than shipping an unlaunchable id.
 *
 * These are the catalogue *definitions*. Other files name machines too, but not
 * as catalogue entries: `machines/machine.ts` declares the `MachineKind` union
 * the registry is checked against, `ui/machine-ui.ts` maps a kind to its
 * lazily-loaded UI contributions, and `ui/panes/model-menu.ts` labels and groups
 * every model for the picker. Those lists are held to the catalog — the manifest
 * keys are typed by `MachineKind`, the menu labels are exhaustive over
 * `MachineModel`, and the menu's completeness is tested.
 *
 * Adding a machine means: create `src/machines/<name>/` with a `descriptor.ts`
 * exporting an entry whose `models` is a literal list of that machine's model
 * ids, add the family's `kind` to `MachineKind` in `machines/machine.ts` and its
 * model type/union member to `src/models.ts`, then add one import + one array
 * entry here. The presentation lists follow — see `docs/adding-a-machine.md`.
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
// Five facts have to hold and all are easy to break silently:
//   1. every `MachineModel` appears in the registry,
//   2. the registry names no model that is not a `MachineModel`,
//   3. every `MachineKind` is exactly one entry's `kind`,
//   4. no model is claimed by two entries, and
//   5. no kind is claimed by two entries.
// A missing model 404s at `entryForModel`; a missing kind leaves `entryForKind`
// returning null; a duplicate kind or model makes the lookup return whichever
// entry happens to come first. These aliases make each one a type error instead:
// `Expect` only accepts `true`, `AssertEqual` yields `never` when the two unions
// differ in either direction, and a duplicate collapses to a non-`never` union.

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type Expect<T extends true> = T;

type RegistryModel = (typeof entries)[number]['models'][number];
type RegistryKind = (typeof entries)[number]['kind'];

/** The tuple's element indices as a union of literal keys ('0' | '1' | …). */
type EntryIndex = Exclude<keyof typeof entries, keyof readonly unknown[]>;
type ModelOf<I extends EntryIndex> = (typeof entries)[I]['models'][number];
type KindOf<I extends EntryIndex> = (typeof entries)[I]['kind'];

/** The model entry I and entry J both claim (never unless they collide). */
type SharedModel<I extends EntryIndex, J extends EntryIndex> =
  I extends J ? never : Extract<ModelOf<I>, ModelOf<J>>;

/** The kind entry I and entry J both claim (never unless they collide). */
type SharedKind<I extends EntryIndex, J extends EntryIndex> =
  I extends J ? never : Extract<KindOf<I>, KindOf<J>>;

/** Every model claimed by more than one entry — `never` when each is unique. */
type DuplicateModels = {
  [I in EntryIndex]: {
    [J in EntryIndex]: SharedModel<I, J>
  }[EntryIndex]
}[EntryIndex];

/** Every kind claimed by more than one entry — `never` when each is unique. */
type DuplicateKinds = {
  [I in EntryIndex]: {
    [J in EntryIndex]: SharedKind<I, J>
  }[EntryIndex]
}[EntryIndex];

/** Type-level proof that the registry covers `MachineModel` and nothing else. */
export type RegistryCoversModels = Expect<AssertEqual<RegistryModel, MachineModel>>;
/** Type-level proof that the registry covers `MachineKind` and nothing else. */
export type RegistryCoversKinds = Expect<AssertEqual<RegistryKind, MachineKind>>;
/** Type-level proof that no two entries list the same model. */
export type RegistryOwnsEachModelOnce = Expect<AssertEqual<DuplicateModels, never>>;
/** Type-level proof that no two entries claim the same kind. */
export type RegistryOwnsEachKindOnce = Expect<AssertEqual<DuplicateKinds, never>>;

/**
 * Forces `tsc` to evaluate every proof. A type alias nobody references is never
 * expanded, so the proof would otherwise be silently vacuous; annotating a value
 * with it makes a divergence from `MachineModel`/`MachineKind`, or a duplicate
 * entry, a hard error. Exported so it is not an unused local; the value itself
 * is never read.
 */
export const registryAgreesWithSpi:
  RegistryCoversModels
  & RegistryCoversKinds
  & RegistryOwnsEachModelOnce
  & RegistryOwnsEachKindOnce = true;

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
