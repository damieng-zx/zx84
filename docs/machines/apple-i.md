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
| **Status** | Working — the Woz Monitor runs on the emulated PIA and terminal. Both ROMs are on the ROM host; Apple I BASIC loads from a `.wav` tape image (not supplied) |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Apple I (`apple1`) | 1976 | 8 KB by default; 4, 8, 16, 32 or 48 KB from `$0000`, plus an optional 4 KB card at `$E000` | 256 bytes (Woz Monitor) | 40 × 24 upper-case terminal | None | Typed-in listings (`.txt`, `.hex`) | The board carried 4 KB or 8 KB; larger sizes are expansion cards |

### ROM sets

| Model | System ROM | Character generator | Notes |
| --- | --- | --- | --- |
| `apple1` | `apple1/apple1.rom` (256 bytes, `$FF00`–`$FFFF`) | `apple2/chargen.rom` (shared with the Apple ][) | `apple1.rom` is on the ROM host (md5 `bdbf2e88ac2183050ac7f7b9a6a363c1`). To use a different Monitor, drop a 256-byte image on the ROM pane (any 256-byte file is claimed as an Apple I). Without the character generator text renders blank rather than failing |

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
| Apple Cassette Interface (ACI) | tape | all | ✅ | Off by default. Fits I/O at `$C000`–`$C0FF` and a 256-byte ROM at `$C100`. Any access to the page toggles the tape output (each toggle is timed on the access's own cycle and recorded for the Save menu) and a read shows the tape input in bit 7; the ROM reads it at `$C081`. Checked against the real ROM: its leader sweeps `LDY $C000,X` with X from `$FF` down to 0, which only makes an unbroken tone if every access toggles. Its ROM is `apple1/aci.rom` on the ROM host (md5 `e128ee213ce8015578ff502eae9b1b6f`) |

---

## Media formats

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.txt`, `.hex` | listing | Keyboard | ✅ | ✗ | Typed in a key at a time, as a person would key it from a listing — a Monitor hex dump (`0280: A9 00 …` then `280R`), or a BASIC program |
| `.a1state` | snapshot | Machine | ✅ | ✅ | zx84's own exact save state (see below) |
| `.wav` | tape | Cassette deck (ACI fitted) | ◐ | ✅ | A recording of the tape audio, played into a comparator with hysteresis (a dead band of 0.3 × the recording's mean level, so tape noise around zero does not chatter) that the ROM's read loop times. Play, pause, stop and rewind; one logical block. Refused unless the ACI is fitted. Save is a recording of the ACI's output toggles since the last reset (`apple1-tape.wav`: 44.1 kHz 16-bit mono square wave, silences between writes cut to 1 s), not a re-save of the mounted tape |

A listing is typed, not poked into memory, so it works wherever the keyboard is
read. One key goes in each time the program has taken the last, so it never goes
faster than the terminal can echo (60 characters a second) and nothing is
injected while the program is not looking for keys. Line endings of any kind
become RETURN; lower case is upper-cased; tabs are spaces; characters with no key
(accents, braces) are dropped. RESET or a machine reset abandons what is left.

**Snapshots.** `.a1state` is zx84's native save state, in the same container as the Atari's `.a8state` (a CRC-32 and length checked before the machine is touched, deflated when saved from the Save menu), magic
`ZXA1`: the 6502, all of RAM, the PIA (registers, interrupt flags, the key
latched on port A), the terminal's screen and cursor and the time its busy line
stays high, the cursor blink, the cassette deck's position and comparator, what
the program has written to the cassette output, and the frame grid. A file
saved from the Save menu also carries the tape, stored as the run of levels
the comparator settles on (all the machine ever sees of it, a few kilobytes
where the audio is megabytes). A state saved with other RAM, the BASIC card or
the ACI fitted differently is refused until the Hardware pane matches. A
listing being typed in is not part of a state. The same state without the tape
backs browser-refresh resume.

**Save menu exports:** Snapshot `.a1state`, Saved tape (`.wav`, with the ACI fitted; reports nothing saved otherwise), screenshot (PNG), RAM dump (the contiguous RAM from `$0000`; the BASIC card is not included).

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
| Trace | ✅ | Full (address, disassembly, registers, cycles and operand context, with interrupt entries marked and tight loops folded) and an I/O tally of the CPU's reads and writes in C000-C0FF (the cassette interface) and D000-DFFF (the PIA) — the shared 6502 trace engine; no ZXTrace, which is a Z80 layout; a trace stops capturing at 500,000 lines |
| Screen OCR / TEXT overlay | ✅ | Read straight from the terminal buffer, so exact |
| Software library | ✗ | |
| Machine-specific panes | ◐ | Keyboard (teletype layout with RESET and CLEAR SCREEN; reuses the Apple ][ skin) and a Hardware section |
| MCP tools | ✅ | The generic tools. `ocr` returns the terminal text exactly; `type` goes through the keyboard. Until the ROM is hosted, put it at `mcp/.cache/apple1.rom` (the cache is keyed by file name) |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| Keyboard pane and Hardware section unchecked in a browser | all | low | Built and type-checked; not yet looked at |

## Not emulated

- Tape output while reading — every access to the ACI page toggles the output, including the ROM's reads of `$C081`, exactly as on the card, so reading a tape also leaves a recording of those toggles in the Save menu.
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
| [`tests/snapshot/apple1-state.test.ts`](../../tests/snapshot/apple1-state.test.ts) — `.a1state`: a synthetic PROM printing to the terminal, reading the ACI from a playing WAV and taking a latched key; a restored machine matches the original frame for frame (registers, cycles, picture, whole state, terminal text); damaged files and other RAM refused untouched; refresh resume | Pass | 2026-10-26 |
| [`tests/apple1.test.ts`](../../tests/apple1.test.ts) — Woz Monitor examine, store and run, terminal pacing, keyboard, listings, display against a synthetic font | Pass | 2026-10-20 |
| ACI with the real ROM: `300.31FW` writes memory to tape and `400.41FR` reads the recording back into other memory, byte for byte, both from the raw toggle times and from the Save menu's `.wav` mounted back through the tape service; plus a recording played into a 6502 read loop, deck transport, ROM mapping, absent when not fitted (`tests/apple1.test.ts`) | Pass | 2026-10-21 |
| [`tests/m6820.test.ts`](../../tests/m6820.test.ts) — PIA registers, flags and handshake | Pass | 2026-10-20 |
| Screenshot against the real 2513 ROM (Monitor dump and punctuation row) | Glyphs correct by eye | 2026-10-20 |
| Hosted `apple1/apple1.rom` against an independently supplied Woz Monitor hex dump (`FF00`–`FFFF`, 256 bytes): identical, md5 `bdbf2e88ac2183050ac7f7b9a6a363c1` | Pass | 2026-10-21 |
| Apple I BASIC from a digitised tape (`Apple 1 BASIC … [load at E000.EFFF, enter at E000].wav`, 44.1 kHz stereo, noisy): `C100R`, `E000.EFFFR`, play, `E000R` — BASIC loads in 36.7 s of emulated time, prints its `>` prompt, and runs a short program (the recording is not in the repository, so this is a manual check) | Pass | 2026-10-21 |
