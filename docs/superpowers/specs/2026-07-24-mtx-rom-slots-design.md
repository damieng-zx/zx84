# MTX hardware UI: model grouping, per-ROM slots, shorter labels

## Problem

Three defects in the recently-added Memotech (MTX) hardware UI:

1. **Model menu** — the machine picker groups Sinclair / Amstrad / Tatung / MSX
   models under manufacturer submenus, but the three Memotech models
   (MTX500, MTX512, RS128) sit loose at the top level.
2. **ROM slots** — the ROM/Carts pane shows a single system-ROM slot labelled
   "OS + BASIC + ASSEM + CP/M + FDX ROMs", even though the emulator already
   fetches those five ROMs as separate files from the CDN
   (`memotech/os.rom`, `basic.rom`, `assem.rom`, `boot-type07.rom`,
   `sdx-type07.rom`) and concatenates them. The Spectrum already renders up to
   four independently-labelled ROM slots — the MTX should do the same.
3. **Hardware option labels** — the checkboxes read "512 KiB RAM expansion",
   "CP/M system", "FDX 80-column display"; they should be terse.

## Approach

Reuse the existing Spectrum multi-slot ROM mechanism for the MTX. That mechanism
already provides: per-slot override storage (`persistROMPage` / `restoreROMPage`
/ `clearROMPage` / `getCachedPage`), the rebuild splice that lays overrides back
onto the default image (`lifecycle.ts`), the pane-info signals
(`updateRomPaneInfo` in `rom.ts`), and the pane rendering (`RomPane.tsx`).

The **only** real difference is slot size: Spectrum slots are 16K; MTX slots are
8K, and there are five of them. The MTX's `MtxMemory.loadRom` already expects a
concatenated image in slot order (OS · BASIC · ASSEM · CP/M · FDX), so a per-slot
override spliced in at an 8K stride reassembles correctly with no memory-mapping
changes.

### Changes

1. **Slot layout (neutral manifest + MTX models).**
   `models.ts` already re-exports `romPageSlotCount` / `defaultRomPageLabel` /
   `RomPage` from `spectrum/models.ts`. Make the manifest-level versions
   dispatch: MTX models use MTX slot metadata (5 slots, 8K each, MTX default
   labels); everything else keeps the Spectrum path. Add a `romSlotSize(model)`
   helper (8192 for MTX, `BANK_SIZE` otherwise). Widen `RomPage` to include `4`.
   MTX slot metadata (count, size, default labels) lives in `mtx/models.ts`.

2. **Size-aware splice.** Replace the hardcoded 16K `BANK_SIZE` stride with
   `romSlotSize(model)` in the two machine-agnostic spots: the rebuild splice
   (`lifecycle.ts`) and the full-image split in `setSystemRomPage` (`rom.ts`).
   Spectrum keeps 16K via the helper's default; MTX gets 8K.

3. **MTX RomService.** `systemSlots` returns five slots (reading `cachedPage`),
   and `setSystemRom` / `resetSystemRom` accept a `page` argument (mirroring the
   Spectrum service) so per-slot uploads and reverts flow through the host ROM
   ops at an 8K stride.

4. **Pane titles.** Add five MTX slot titles + eject titles to the
   `ROM_PAGE_SLOTS` map in `RomPane.tsx` (inline, matching the existing
   Spectrum `PLUS3_SLOTS` pattern), keyed for all three MTX models.

5. **Model grouping (cosmetic).** Wrap the three MTX entries in a
   `{ value: 'memotech', label: 'Memotech', children: [...] }` submenu in
   `HardwarePane.tsx`.

6. **Labels (cosmetic).** In `mtx/ui/hardware-section.tsx`:
   "512 KiB RAM expansion" → **512KB RAM**; "FDX 80-column display" →
   **80-columns**; "CP/M system" → **CP/M**. The `title=` tooltips keep the
   full descriptions.

### Slot order and default labels

| Slot | Region (`MtxMemory`) | Default source | Default label |
|------|----------------------|----------------|---------------|
| 0 | `osRom`        | `memotech/os.rom`         | MTX OS |
| 1 | `romPages[0]`  | `memotech/basic.rom`      | MTX BASIC |
| 2 | `romPages[1]`  | `memotech/assem.rom`      | MTX ASSEM |
| 3 | `romPages[4]`  | `memotech/boot-type07.rom`| CP/M Bootstrap |
| 4 | `romPages[5]`  | `memotech/sdx-type07.rom` | FDX Disk BASIC |

The concatenation order (slot index × 8K) matches `loadRom`'s expected layout,
so the splice needs no MTX-specific offset table.

## Non-goals

- No change to MTX memory mapping, ROM fetching, or the default firmware images.
- `romPages` UI capability stays `0` for MTX (the ROM pane is already visible via
  the cartridge slot; the multi-slot render keys off `ROM_PAGE_SLOTS`, not this
  cap). Left as-is to avoid widening the `0 | 2 | 4` type for an unused path.
- Overrides remain keyed per-model (an OS ROM uploaded on MTX512 does not carry
  to MTX500), consistent with existing Spectrum behaviour.

## Testing

- `romPageSlotCount` / `romSlotSize` / `defaultRomPageLabel` for all three MTX
  models (5 slots, 8192 bytes, correct default labels per slot index).
- `MtxRomService.systemSlots` returns five slots with default labels when no
  override is present.
- A per-slot override splices into the correct 8K region of the reassembled
  image (e.g. an override on slot 2 lands at bytes 0x4000–0x5FFF and reaches
  `romPages[1]`), leaving other slots at their defaults.
- Existing Spectrum ROM-slot tests continue to pass (16K stride unchanged).
