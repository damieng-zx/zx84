# Adding a machine

This is the definition-of-done checklist for the "machines as hardware" layout
(see `docs/re-architecture.md`). Adding machine #5 — including a 6502-based one —
touches **only** a new `src/machines/<name>/` folder, one line each in
`registry.ts` and `models.ts`, optional `ui/` contributions, and an optional new
`debug-<family>/` module. **Nothing else in the tree changes.** If you find
yourself editing a shell file, a generic component, or a core to add a machine,
stop — the seam you need already exists (or belongs in your machine folder).

## The mental model

A machine folder is a motherboard. It instantiates commodity chips from
`src/cores/`, owns its custom silicon and peripherals, wires port decode and
interrupts, and exposes everything above it through **services** — never by
letting the shell/UI/MCP narrow to your concrete class. The generic panes bind
to `machine.services` and your `descriptor.ui` capability flags; they must stay
machine-blind.

## Checklist

### 1. Create the folder `src/machines/<name>/`

Populate it as a motherboard (omit what your hardware lacks):

- `<name>-machine.ts` — the machine class. Extend `BaseMachine` (frame loop,
  pacing, turbo, audio back-pressure, debug-field storage) and implement the
  `Machine` SPI from `machines/machine.ts`. Own your `runFrame()`: poll chip
  interrupt flags and call `cpu.interrupt()` yourself (the audited model — cores
  never call back into the machine). Keep `cpu.portInHandler`/`portOutHandler`
  as direct closures — they are tier-1 hot paths.
- Custom silicon and support files as needed: `ula.ts`/`gate-array.ts`/`vdp`
  wiring, `contention.ts`, `variants/`, `memory.ts`, `io.ts` (the port-decode
  if-chain), `keyboard.ts`, `peripherals/`, `snapshots/`, `tape-loader.ts`.
  Commodity chips come from `src/cores/`; format codecs from `src/media/`.
- `models.ts` — your family's model-classification helpers. The `MachineModel`
  union members themselves live in the top-level `src/models.ts` (step 6).

A machine folder is an **island**: it may import its own folder, the SPI
(`machine.ts`), `base-machine.ts`, `registry.ts`, `shared/`, a `debug-<family>/`
module, `src/cores/`, `src/media/`, and `src/utils/` — and **nothing** from
another machine folder, UI, state, the store, the shell, or solid-js. (`ui/` is
the sole exception — see step 4.) `npm run depcheck` enforces this.

### 2. `descriptor.ts` — pure metadata + factory

Export a `MachineEntry` (and a reusable `descriptor(model)` function). It is
imported only by `registry.ts` and **must stay headless-safe** (no solid-js, no
reactive state — the MCP/Node/test builds import it). Provide:

- `kind`, `models`, `descriptor(model)` (screen geometry + `cpuFamily` +
  `MachineUiCapabilities`), `create(model, display)`, `romSources(model)`.
- Optional `detectModelForRom(data, current)` if a raw system-ROM drop should
  boot your family (ROM-size → model classification lives here, not the shell).

Fill in `descriptor.ui` (`MachineUiCapabilities`) honestly — those flags are how
the generic panes adapt (`builtinDisk`, `cartridge`, `tape: 'deck' | 'instant'`,
`colorMap`, `romPages`, `memoryRegions`, `hiddenPanes`, …). No pane should ever
need to learn your `kind`.

### 3. `services/` — the surface everything above binds to

Implement `MachineServices`. Each service reaches your machine's internals (same
folder — allowed) and is consumed only on cold paths (user actions / once per
frame):

- `media` — file routing (`accepts()` + `mount()`); owns ALL of "which device
  inside this machine" for every extension × enabled-peripheral combination.
- `roms` — system-ROM slots + optional cartridge slot.
- `tape` / `disks` / `snapshots` — return the service, or `null` when the
  hardware isn't fitted. Optional SPI hooks (`disks.formatBlank?`,
  `snapshots.saveSync?`, `armBootTrap?`) are presence-detected by the shell.
- `debug` — a `DebugService` for your CPU family, backed by a
  `machines/debug-<family>/` module (step 5).
- `input` — map host key/mouse/joystick events onto your own hardware.
- `probe` — a `FrameProbe` whose `sample()` fills the shared `FrameIndicators`
  struct and **allocates nothing** (tier-3 hot path); `frameTick()` does the
  once-per-UI-frame device bookkeeping.

### 4. Optional `ui/` contributions

A machine's `ui/` subfolder is the ONLY place its files may import solid-js and
the shell/state layers. Put Hardware-pane sections, sysvars/BASIC panels, an
on-screen keyboard, and per-family debug panels here. Register them in the
UI-side manifest `src/components/machine-ui.ts` (`kind` → lazily-imported
components) — that manifest is the single sanctioned exception to
"components never import a machine folder". A `ui/` file that needs its concrete
machine narrows the shell's handle itself (see `spectrum/ui/active.ts`).

### 5. Optional new `debug-<family>/` (new CPU family)

If your machine's CPU isn't already supported (i.e. not `z80`):

- Add `src/machines/debug-<family>/` — the disassembler, step-over/step-out
  reasoning, trace formats, and register descriptors for that family. This is
  shared substrate; any machine of that family imports it.
- Set `descriptor.cpuFamily` to the new family and extend the `CpuFamily` union
  in `machines/machine.ts`.
- Ship a per-family debug UI panel (a *different* register/disassembly component
  is expected and fine) and register it in `machine-ui.ts`. The generic debug
  chrome (breakpoint list, hex memory view, trace buttons) binds to
  `DebugService` and works unchanged.

**Worked example — a 6502 machine (e.g. BBC/C64):** create
`src/machines/bbc/` per steps 1–4; add `src/machines/debug-m6502/` with a 6502
disassembler + register descriptors; set `cpuFamily: 'm6502'`; add a
`M6502RegisterPane`/`M6502DisassemblyPane` under `bbc/ui/` and register them in
`machine-ui.ts` keyed off `cpuFamily`. The MCP `registers`/`step`/`trace` tools,
the breakpoint list, and the memory pane keep working because they bind to
`DebugService`, not to Z80.

### 6. Register it (the only two manifests)

- `src/machines/registry.ts` — one `import` + one array entry.
- `src/models.ts` — add your models to the `MachineModel` union (and any leaf
  helper like an `isBbcModel` guard if the union needs one).

### 7. ROM sources

List each model's system-ROM image URLs in `descriptor.romSources(model)`. The
shared `rom-manager` fetches, caches (IndexedDB), concatenates, and persists them
generically; peripheral ROMs go through `AuxRomRequest` from your `prepare()`/
`bootRoms()` hooks.

## What NOT to touch

Nothing else. In particular: no edits to `src/cores/` (add a *new* core only if
your machine uses a genuinely new commodity chip), `src/shell/*`,
`src/frame-bridge.ts`, `src/components/*` generic panes, `src/state/*`,
`src/media/*`, or another machine's folder. If a generic pane can't express your
machine, add a `descriptor.ui` capability flag it can read — don't branch on
`kind`.

## Gates

Run all three green before considering it done:

```
npx tsc --noEmit          # clean
npx vitest run            # 0 failed
npm run depcheck          # 0 violations, 0 exceptions
```

`depcheck` is the structural proof: if your machine folder leaked an import into
UI/state/shell, or a pane learned your `kind`, it fails.
