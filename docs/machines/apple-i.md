# Apple I

Apple's first product, hand-built by Steve Wozniak in 1976: a 6502, a few
kilobytes of RAM, a 256-byte Monitor PROM and a video terminal made from a
keyboard and TV. zx84 emulates the board with its PIA-driven keyboard and
terminal, the Woz Monitor, and the memory and cassette-interface expansions
people fitted.

| | |
| --- | --- |
| **Manufacturer** | Apple Computer (designed by Steve Wozniak) |
| **Released** | 1976 |
| **CPU** | MOS 6502 — 1.022727 MHz |
| **zx84 kind** | `apple1` — [`src/machines/apple1/`](../../src/machines/apple1/) |
| **Model ids** | `apple1` — the MCP `model` target and `?model=` value |
| **Accuracy** | Instruction-level CPU with per-instruction cycle counts; 65 cycles × 262 lines = 17,030 cycles per frame, paced at 60.05 Hz; the terminal's 60 characters a second is modelled in cycles; display rendered once per frame |
| **Status** | Working — the Woz Monitor runs on the emulated PIA and terminal. The 256-byte ROM is not yet on the ROM host (see ROM sets) |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Apple I (`apple1`) | 1976 | 8 KB by default; 4, 8, 16, 32 or 48 KB from `$0000`, plus an optional 4 KB card at `$E000` | 256 bytes (Woz Monitor) | 40 × 24 upper-case terminal | None | Typed-in listings (`.txt`, `.hex`) | The board carried 4 KB or 8 KB; larger sizes are expansion cards |

### ROM sets

| Model | System ROM | Character generator | Notes |
| --- | --- | --- | --- |
| `apple1` | `apple1/apple1.rom` (256 bytes, `$FF00`–`$FFFF`) | `apple2/chargen.rom` (shared with the Apple ][) | **`apple1.rom` is not hosted yet**: drop a 256-byte image on the ROM pane (any 256-byte file is claimed as an Apple I), or the machine has no Monitor. Without the character generator text renders blank rather than failing |

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| MOS 6502 CPU | all | ✅ | [`src/cores/m6502.ts`](../../src/cores/m6502.ts) |
| MC6820 PIA | all | ✅ | [`src/cores/m6820.ts`](../../src/cores/m6820.ts). Data/DDR switching, interrupt flags, the C2 handshake and pulse modes. Registers at `$D010`–`$D013`, repeated through the `$Dxxx` page wherever address bit 4 is set |
| Keyboard | all | ✅ | Encoder on PIA port A, strobe on CA1. Upper case only; the code stays latched until the next key. [`apple1-keyboard.ts`](../../src/machines/apple1/apple1-keyboard.ts) |
| Video terminal | all | ✅ | 40 × 24 cells of a 5 × 7 glyph in a 7 × 8 dot cell, a blinking `@` cursor, scroll on the bottom row. Busy (60 characters a second) is port B bit 7. [`apple1-terminal.ts`](../../src/machines/apple1/apple1-terminal.ts), [`apple1-video.ts`](../../src/machines/apple1/apple1-video.ts) |
| Character generator | all | ✅ | The 2513 64-glyph ROM, as in the Apple ][ |
| Woz Monitor | all | ✅ | 256-byte PROM at `$FF00`; NMI vector `$0F00`, RESET `$FF00` |
| RAM | all | ✅ | See Models; unmapped addresses read `$FF` |

---

## Peripherals

Fitted in the Hardware pane. Every change rebuilds the machine.

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| RAM size | memory | all | ✅ | 4, 8, 16, 32 or 48 KB contiguous from `$0000` |
| BASIC RAM card | memory | all | ✅ | 4 KB at `$E000`–`$EFFF`, where Apple BASIC loads. On by default |
| Apple Cassette Interface | tape | all | ✗ | Not yet implemented |

---

## Media formats

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.txt`, `.hex` | listing | Keyboard | ✅ | ✗ | Typed in a key at a time, as a person would key it from a listing — a Monitor hex dump (`0280: A9 00 …` then `280R`), or a BASIC program |

A listing is typed, not poked into memory, so it works wherever the keyboard is
read. One key goes in each time the program has taken the last, so it never goes
faster than the terminal can echo (60 characters a second) and nothing is
injected while the program is not looking for keys. Line endings of any kind
become RETURN; lower case is upper-cased; tabs are spaces; characters with no key
(accents, braces) are dropped. RESET or a machine reset abandons what is left.

**Save menu exports:** screenshot (PNG), RAM dump (the contiguous RAM from `$0000`; the BASIC card is not included).

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Terminal speed | ✅ | 17,045 cycles per character; a CR takes the same time as any other character |
| Host keys | ✅ | **Pause** is RESET (CPU and PIA; RAM and screen survive), **Home** is CLEAR SCREEN (terminal only). Escape is ESC, Backspace and Delete send `_` (the Monitor's backspace) |
| Phosphor colour | ✅ | The Monitor pane's green, amber and so on; the machine draws white |
| Turbo | ✅ | Runs frames faster; listings type faster with it |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | The shared 6502 debug service; no I/O ports. Memory-mapped PIA reads in the Memory pane use a side-effect-free peek |
| Trace | ✗ | |
| Screen OCR / TEXT overlay | ✅ | Read straight from the terminal buffer, so exact |
| Software library | ✗ | |
| Machine-specific panes | ◐ | Keyboard (teletype layout with RESET and CLEAR SCREEN; reuses the Apple ][ skin) and a Hardware section |
| MCP tools | ✅ | The generic tools. `ocr` returns the terminal text exactly; `type` goes through the keyboard. Until the ROM is hosted, put it at `mcp/.cache/apple1.rom` (the cache is keyed by file name) |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| Monitor ROM not on the ROM host | all | high | Needs `apple1/apple1.rom` uploaded; the 256 bytes in `tools/out/apple1-roms/` are reproduced from the published listing and run correctly, but have not been compared with a known-good dump |
| Keyboard pane and Hardware section unchecked in a browser | all | low | Built and type-checked; not yet looked at |

## Not emulated

- Apple Cassette Interface — a tape cannot be loaded yet, so Apple I BASIC (a tape image, normally loaded to `$E000`) cannot be started except by typing it in.
- The terminal's cursor is a blinking `@` only; the real display's exact cursor timing is approximate.
- Memory contents at power-on are zero rather than random.
- The PIA's interrupt lines are not wired to the CPU, as on the real board.

## Faithful quirks

- **Blank line after each command** — the Monitor prints a RETURN before every result, so output appears after an empty line.
- **`280R` shows `0280: A9` first** — typing an address then `R` examines it before running, so the program's own output follows on that line.
- **Stores into unmapped RAM vanish** — writing above the fitted RAM (or to `$E000` without the BASIC card) is ignored and reads back `$FF`.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| [`tests/apple1.test.ts`](../../tests/apple1.test.ts) — Woz Monitor examine, store and run, terminal pacing, keyboard, listings, display against a synthetic font | Pass | 2026-10-20 |
| [`tests/m6820.test.ts`](../../tests/m6820.test.ts) — PIA registers, flags and handshake | Pass | 2026-10-20 |
| Screenshot against the real 2513 ROM (Monitor dump and punctuation row) | Glyphs correct by eye | 2026-10-20 |
