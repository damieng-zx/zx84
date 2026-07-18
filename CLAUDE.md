# ZX84 — Claude Code Guidelines

## Architecture

The codebase is layered "machines as hardware, components as chips" — see
`docs/re-architecture.md` for the full rationale and `docs/adding-a-machine.md`
for the new-machine checklist. Dependencies point strictly downward and the
boundaries are enforced mechanically (`npm run depcheck`, zero exceptions).

### Layer map

- `src/cores/` — **commodity silicon only**: chips that shipped in more than one
  machine (Z80, AY-3-891x, TMS9918A, CRTC 6845, uPD765A, WD179x/1772/1793, Z80
  CTC, i8255). Pure — imports only other cores, `src/media/` *types*, `src/utils/`.
  Custom silicon that only ever existed in one machine (the Spectrum's Ferranti
  ULA, the CPC's Amstrad gate array, the microdrive) is **not** here — it lives
  in that machine's folder.
- `src/machines/<name>/` — **one folder per machine = a motherboard**. Everything
  specific to that machine: the machine class (extends `base-machine.ts`), its
  custom silicon (`spectrum/ula.ts`, `cpc/gate-array.ts`), `contention.ts`,
  `variants/`, `memory.ts`, `io.ts` (port decode if-chain — hot, load-bearing),
  `keyboard.ts`, `peripherals/`, `snapshots/`, `tape-loader.ts`, per-family
  `models.ts` helpers, `descriptor.ts` (pure metadata + factory), `services/`
  (the service surface), and `ui/` (Solid contributions — the ONLY machine files
  allowed to import solid-js and the shell/state layers). A machine folder is an
  island: it never imports another machine folder, nor UI/state/store/shell.
- `src/machines/machine.ts` — the **SPI**: `Machine`, `MachineServices`, the
  service interfaces (media/roms/tape/disks/snapshots/debug/input/probe),
  `MachineDescriptor` + `MachineUiCapabilities`, `MachineHost`, `MachineEntry`.
- `src/machines/base-machine.ts` — shared driver loop (frame pacing, turbo pump,
  audio back-pressure, lifecycle, debug-field storage). Untouched by machines.
- `src/machines/registry.ts` — the **parts catalog**: the only file besides
  `src/models.ts` allowed to name every machine. Stays headless-safe.
- `src/media/` — format codecs → neutral models: `floppy/` (`DskImage`,
  DSK/HFE/SCP/MGT/TRD/SCL, `disk-detect.ts`, `floppy-sound.ts`), `tape/`
  (TAP/TZX/CSW deck + `.cas`), `zip.ts`. Pure — imports only media + utils.
- `src/shell/` — the host: `context.ts` (shared machine handle + managers),
  `lifecycle.ts` (create/switch/destroy, pause/turbo, stepping, refresh state),
  `media.ts` (zip/picker/dispatch/persistence + transport wrappers),
  `settings.ts` (SettingsView pump), `rom.ts` (fetch/cache/persist). Reaches
  machines **only** through `machine.services` and the SPI/registry — never a
  concrete machine folder.
- `src/state/` — Solid reactive stores (machine, debug, disk, tape, activity,
  microdrive). Shared flat signal bags; the *writers* are generic (shell + probe).
- `src/store/` — settings + IndexedDB persistence.
- `src/ui/` — generic UI: `panes/` hosts panes and `components/` hosts reusable
  elements. Bind to `machine.services` and the descriptor's `ui` capabilities;
  never import a concrete machine or branch on machine kind. `machine-ui.ts` is
  the UI-side manifest mapping a kind → its
  lazily-imported `ui/` contributions (the sole sanctioned exception).
- `src/frame-bridge.ts` — the generic per-frame consumer of each machine's
  `FrameProbe`; owns presentation policy (LED latch, formatting, diffing).
- `src/managers/` — `debug-manager` + `rom-manager`: generic orchestration.
- `src/models.ts` — the `MachineModel` union manifest + leaf helpers
  (`isCpcModel`, …). Per-family helpers (`is128kClass`, `isPlusDCapable`, …)
  live in each machine's own `models.ts`.
- `src/debug/` — machine-agnostic debug tools (BASIC parser, screen OCR
  `screen-text.ts`) plus per-CPU-family debug substrate in `src/debug/<family>/`
  (`z80/`: `disasm.ts` disassembler + `service.ts` `Z80DebugService`/`z80Cpu()`,
  step-over/out logic, register surface — shared by every Z80 machine). A
  machine may import its *family* module — that's substrate, not another
  machine. Imports only cores, utils, and machine SPI *types*. These tools take
  `Uint8Array`, not `ByteReader`.
- `src/display/` — Canvas and WebGL renderers with HQx/xBR upscaling shaders.
- `src/emulator.ts` — a thin **compatibility shim** (re-exports shell + state),
  retained only because `frame-bridge.ts` and its module-mock tests still import
  from it. New code imports from `@/shell/*` and `@/state/*` directly.
- `mcp/` — MCP server (persistent Node process; `mcp/server.ts` entry, tools
  under `mcp/tools/`). Binds to `state.spec.services`; `mcp/concrete.ts` is the
  single sanctioned module that narrows to a concrete machine.

### Services model (UI binds to services, never machine kinds)

Everything above the machine layer reaches machine internals through
`machine.services` (§3.3 of the re-architecture) and the descriptor's static
`ui` capabilities — never by narrowing to a concrete machine or testing
`machine.kind`. A machine that lacks a piece of hardware returns `null` for that
service (or omits an optional SPI hook) and the pane hides/disables itself. The
only concrete narrowings left are the two sanctioned seams: `mcp/concrete.ts`
(bench-probe machine-specific MCP tools) and `machines/spectrum/ui/active.ts`
(the Spectrum's own `ui/` contributions reaching their machine).

### Hot-path rules (see re-architecture §6)

- **Tiers 1–2 are untouchable** (per-t-state exec + memory access, per-scanline
  render). No interface sits between a machine and its chips, memory, or port
  handlers; inside a machine, code refers to concrete `this.ula`/`this.fdc`
  fields, never through its own service interfaces.
- **The `Machine` SPI is consumed only on tiers 3–4** (once-per-frame probe +
  user actions). `FrameProbe.sample()` overwrites one preallocated
  `FrameIndicators` struct and allocates nothing. Services may allocate freely.

### Memory architecture

`SpectrumMemory` lives at `machines/spectrum/memory.ts`. Each of the 8 × 16KB
RAM banks is the single authoritative source for its data. The Z80 address space
is a 4-slot view into those banks (and ROM pages), updated O(1) on each bank switch.

- **Z80 execution** — must go through `memory.readByte(addr)` / `memory.writeByte(addr, val)`. These do the slot/paging lookup.
- **Debug tools and UI** — use `Uint8Array` directly via the SPI: `machine.memory.snapshot()` for a full 64KB view, or `machine.memory.getRamBank(n)` for a specific bank.
- **`memory.snapshot()`** allocates a fresh 64KB `Uint8Array` — don't call it from hot paths (e.g. per traced instruction). The trace path goes through `machine.services.debug` (disassembly reads just a few bytes).
- **Multiface / VTX overlays** use `memory.setSlot0(overlay)` / `memory.restoreSlot0()` to temporarily replace slot 0. Pass `skipSlot0 = true` to `bankSwitch()` while an overlay is active.

## Build and type-checking

```
npx tsc --noEmit          # type-check (no output = clean)
npx vite build            # production build
```

## Writing tests

Tests must be written critically against a known-correct specification, not as a mirror of the current implementation.

- **Don't blindly assert existing behaviour.** Before writing an assertion, verify the expected value is correct — check the hardware spec, reference docs, or a trusted external source. If the code under test is wrong, the test should catch it, not encode the bug.
- **Derive expectations independently.** Work out the correct result yourself (or from spec) and hard-code that value. Never call the function under test to generate the expected value.
- **Prefer edge cases over happy paths.** The interesting bugs live at boundaries: overflow, underflow, wrap-around, flag interactions, off-by-one errors. Cover those first.
- **One clear failure message.** Each test should have a single, obvious reason to fail so the diagnostic points directly to the broken behaviour.
- **Tests that can never fail are useless.** If an assertion can only fail when you've already broken the test itself, delete it.

## Workflow rules

- **No `cd` in commands.** Don't prefix commands with `cd /path &&`. It breaks the permission model. Qualify file paths on the command itself (e.g. `npx tsc --noEmit` run from the project root).
- **Never commit.** Do not run `git add`, `git commit`, or `git push` unless the user explicitly asks. The user manages their own commits.
- **Run the full test suite before any commit, and only commit when it's green.** Before running `git commit`, run `npx vitest run` and confirm `0 failed`. If anything fails — even a test unrelated to your change — stop and surface it; do not commit over red tests. `npx tsc --noEmit` should also be clean.
- **When asked to commit, use `git commit --only -- <files>`.** Multiple Claude instances may share this working tree, so the index can already contain files staged by another instance. `git add` followed by `git commit` sweeps those in. `git commit --only -- path1 path2 …` commits *only* the listed paths, leaving everything else in the index untouched. Always run `git diff --cached --name-only` first as a sanity check.
- **Present options for non-trivial features.** If there are multiple reasonable approaches, describe them and let the user choose — don't silently pick the smallest diff.

## Common pitfalls

- **Port 0xFE is shared**: keyboard reads and tape EAR reads both hit the ULA port. Distinguish by the high byte of the port address (0xFF = no row selected = EAR-only read; anything else selects keyboard half-rows).

- **Memory access layer**: only the Z80 execution path uses `readByte`/`writeByte`. Debug tools (`src/debug/`), UI components, and snapshot code use `Uint8Array` directly — either a `snapshot()` or a specific bank array. Don't add `ByteReader` parameters to debug tool functions.

- **Contention models differ**: Ferranti ULA (48K/128K/+2) vs Amstrad gate array (+2A/+3) have different contention patterns, different contended banks, and different IO contention rules. Check `machines/spectrum/contention.ts` and `timings.md` before touching timing-sensitive code.

- **Port decode is hot**: `machines/spectrum/io.ts` (and each machine's `io.ts`) wires CPU port I/O to the cores as an ordered if-chain whose early returns prevent double-decode. It's a tier-1 hot path — no interfaces, no logic changes beyond the wiring.

- **FDC drive aliasing**: on the +3, units 2/3 alias to physical drives 0/1 (`physUnit = unit & 1`). Use the alias for all physical resource access (disk images, track positions); keep the original logical unit for ST0/ST3 result bits.

- **`romPages` indexing**: for +2A/+3 (4 ROM pages), the 48K BASIC ROM is page 3. For 128K/+2 (2 ROM pages), it's page 1. `spectrum.romFont` (on `machines/spectrum/spectrum.ts`) handles this correctly — use it rather than indexing `romPages` directly.
