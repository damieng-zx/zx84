# ZX84 — Claude Code Guidelines

## Architecture

### Source layout

- `src/cores/` — hardware cores (Z80, ULA, AY-3-8910, uPD765A FDC). Pure emulation logic, no UI or framework dependencies.
- `src/variants/` — `MachineVariant` strategy objects. Model-specific behaviour (contention pattern, contended banks, I/O contention, port decode) lives here instead of inline `if (model)` checks. One factory per class: 48K, Ferranti 128K/+2, Amstrad +2A/+3.
- `src/spectrum.ts` — the main machine. Owns the frame loop, orchestrates cores, is the authority on machine state.
- `src/io-ports.ts` — wires CPU port I/O to the appropriate cores. Thin glue only, no business logic.
- `src/contention.ts` — ULA memory/IO contention timing (Ferranti vs Amstrad models differ — see below).
- `src/frame-bridge.ts` — transfers per-frame state from the emulator to the Solid.js UI. Read-only consumer of machine state.
- `src/memory.ts` — `SpectrumMemory`: slot-based paged memory, 8 × 16KB RAM banks, ROM pages.
- `src/models.ts` — `SpectrumModel` type and classification helpers (`is128kClass`, `isPlus2AClass`, etc.).
- `src/debug/` — disassembler, BASIC parser, screen OCR (`screen-text.ts`). These tools take `Uint8Array`, not `ByteReader`.
- `src/peripherals/` — Multiface 1/128/3, VTX-5000 Prestel modem, Kempston mouse, AMX mouse, joysticks, audio mixer.
- `src/tape/` — TAP/TZX parsing, tape playback engine, custom loader auto-detection.
- `src/floppy/` — floppy disk image formats and the shared `DskImage` model (`disk-image.ts`). DSK/HFE/SCP for the uPD765A (+3/CPC), MGT for the +D, TRD/SCL for the Beta Disk; copy-protection detection (`disk-detect.ts`); drive-sound synthesis (`floppy-sound.ts`). The FDC cores themselves live in `src/cores/` (uPD765A, WD179x), not here.
- `src/display/` — Canvas and WebGL renderers with HQx/xBR upscaling shaders.
- `src/state/` — Solid.js reactive state stores (machine, debug, disk, tape, activity).
- `src/store/` — Settings and IndexedDB persistence.
- `src/managers/` — debug-manager, media-manager, rom-manager. Higher-level orchestration over the emulator.
- `src/snapshot/` — SNA, Z80, SZX, SP snapshot loaders/savers, ZIP extraction.
- `mcp/` — MCP server for Claude Code integration (persistent Node process; `mcp/server.ts` is the entry point, tool handlers live under `mcp/tools/`).

### Memory architecture

Each of the 8 × 16KB RAM banks is the single authoritative source for its data. The Z80 address space is a 4-slot view into those banks (and ROM pages), updated O(1) on each bank switch.

- **Z80 execution** — must go through `memory.readByte(addr)` / `memory.writeByte(addr, val)`. These do the slot/paging lookup.
- **Debug tools and UI** — use `Uint8Array` directly. Call `memory.snapshot()` for a full 64KB view, or `memory.getRamBank(n)` / `memory.screenBank` for a specific bank.
- **`memory.snapshot()`** allocates a fresh 64KB `Uint8Array` — don't call it from hot paths (e.g. per traced instruction). The trace path uses `spectrum.disasmAt(pc)` which reads just 8 bytes.
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

- **Contention models differ**: Ferranti ULA (48K/128K/+2) vs Amstrad gate array (+2A/+3) have different contention patterns, different contended banks, and different IO contention rules. Check `contention.ts` and `timings.md` before touching timing-sensitive code.

- **FDC drive aliasing**: on the +3, units 2/3 alias to physical drives 0/1 (`physUnit = unit & 1`). Use the alias for all physical resource access (disk images, track positions); keep the original logical unit for ST0/ST3 result bits.

- **`romPages` indexing**: for +2A/+3 (4 ROM pages), the 48K BASIC ROM is page 3. For 128K/+2 (2 ROM pages), it's page 1. `spectrum.romFont` handles this correctly — use it rather than indexing `romPages` directly.
