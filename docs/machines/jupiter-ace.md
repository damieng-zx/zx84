# Jupiter Ace

Jupiter Cantab's Z80 home computer, which shipped with FORTH in ROM instead of
BASIC. zx84 emulates the 3 KB machine with its monochrome text ULA, piezo
buzzer and cassette port, plus the official 16 KB and 48 KB RAM packs.

| | |
| --- | --- |
| **Manufacturer** | Jupiter Cantab |
| **Released** | 1983 |
| **CPU** | Zilog Z80A — 3.25 MHz (6.5 MHz crystal ÷ 2) |
| **zx84 kind** | `jupiter-ace` — [`src/machines/jupiter-ace/`](../../src/machines/jupiter-ace/) |
| **Model ids** | `jupiter-ace` — the MCP `model` target and `?model=` value |
| **Accuracy** | Scanline: the CPU runs one 208 T-state line at a time and each of the 192 active lines is drawn after it; no memory contention; no accuracy setting |
| **Status** | Keyboard, display, buzzer and cassette load and save implemented and unit-tested; no recorded oracle results |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Jupiter Ace (`jupiter-ace`) | 1983 | 3 KB stock (1 KB video + 1 KB character + 1 KB main); optional 16 KB or 48 KB RAM pack | 8 KB FORTH | Ace ULA, 32×24 monochrome text | Piezo buzzer | Cassette | 208 T × 312 lines = 64,896 T per frame (50.08 Hz) |

The RAM pack is chosen in the Hardware pane (RAM selector) and defaults to the
48 KB pack. Changing it rebuilds the machine, because the ROM probes the
expansion once at boot and sets RAMTOP from it. The MCP server always starts the
machine with the default 48 KB pack.

| RAM option | Setting value | Mapped at | Total RAM |
| --- | --- | --- | --- |
| Stock 3K | `none` | — (0x4000–0xFFFF reads 0xFF, writes dropped) | 3 KB |
| 16K RAM pack | `16k` | 0x4000–0x7FFF | 19 KB |
| 48K RAM pack | `48k` (default) | 0x4000–0xFFFF | 51 KB |

### ROM sets

| Model | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| Jupiter Ace | UK only (no locale variants) | One 8 KB image (`jupiter/ace.rom`) at 0x0000–0x1FFF | Hosted |

The ROM can be replaced from the ROM pane. A 4 KB dump (one chip) is mirrored
into the second 4 KB half. Dropping a raw 8 KB or 4 KB ROM image is accepted
only while the Ace is the active machine; it never switches models.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| Z80A CPU | all | ✅ | Shared core [`src/cores/`](../../src/cores/); /INT served in interrupt mode 1 |
| Ace ULA | all | ✅ | [`ula.ts`](../../src/machines/jupiter-ace/ula.ts): keyboard scan, cassette EAR/MIC and buzzer on any even port |
| Text display | all | ✅ | 32×24 cells of 8×8 pixels, 256×192 active area; black ink on white paper; bit 7 of a character code is inverse video; border always paper-white |
| Video RAM | all | ✅ | 1 KB chip at 0x2000–0x27FF; screen file at 0x2400–0x26FF (linear, not the Spectrum's interleave) |
| Character RAM | all | ✅ | 1 KB chip at 0x2800–0x2FFF, 128 glyphs × 8 rows, writable so programs can redefine the set |
| Main RAM | all | ✅ | 1 KB chip at 0x3000–0x3FFF |
| FORTH ROM | all | ✅ | 8 KB at 0x0000–0x1FFF, no mirror |
| RAM pack | all | ✅ | Optional 16 KB or 48 KB at 0x4000 (see Models) |
| Keyboard | all | ✅ | 40-key matrix, 8 half-rows × 5 bits, with a dedicated SYMBOL SHIFT key |
| Buzzer | all | ✅ | Flip-flop set by any ULA port write and cleared by any read; the FORTH `BEEP` word toggles it |
| Cassette interface | all | ✅ | EAR input from the tape deck; MIC output (bit 3 of the port write) timed for saving |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Jupiter Cantab RAM pack | RAM | all | ✅ | 16 KB or 48 KB, selected in the Hardware pane |

**Combination rules:** None. The Hardware pane offers only the RAM selector;
the Ace has no disk, joystick, mouse or cartridge hardware, and those panes are
hidden.

---

## Media formats

ZIP archives are accepted by the Load picker and routed as below.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.tap` | Tape | Tape deck | ✅ | ✅ | Ace `.tap`: `[length16][bytes]` chunks with no flag byte; a 26-byte chunk is a header unless it follows one. Save writes whatever the machine `SAVE`d |
| `.tzx` | Tape | Tape deck | ✅ | ✗ | |
| `.csw` | Tape | Tape deck | ✅ | ✗ | |

A mounted tape is positioned at the start with the deck paused. The mount
message names the exact command to type: `LOAD <name>` for a dictionary file
(then type the word itself to run it) or `BLOAD <name>` for a bytes file. The
Ace's `LOAD` takes the name unquoted and compares it literally, so the case
must match the name on the tape. `.cdt` is not accepted.

There are no snapshot, disk or cartridge formats.

**Save menu exports:** Tape `.tap` (the cassette-port `SAVE` captured by the MIC
recorder; named after the first file on it, or `jupiter-ace.tap`), PNG
screenshot, RAM `.bin` (`jupiter-ace-ram.bin`: video RAM, character RAM and main
RAM, then the RAM pack when fitted).

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Frame timing | ✅ | 312 lines × 208 T-states = 64,896 T-states per frame, giving 50.08 Hz |
| Interrupt window | ✅ | /INT is held for the eight vertical-sync scanlines after the 192 active lines; a CPU that is masking interrupts can still take it if it re-enables within the window |
| Memory contention | ✗ | None applied (see Not emulated) |
| Cassette save | ✅ | The ROM's own `SAVE` routine runs unpatched and the MIC edges are decoded back into a `.tap`; stray beeps without a leader are ignored |
| Cassette load pulses | ✅ | Pilot, sync and bit widths come from the ROM's `SAVE` routine, scaled to the 3.25 MHz clock |
| Turbo loading | ✅ | Runs the CPU flat out while the loader is polling the tape; a "turbo while loading" setting turns it off; a user stop wins |
| Loader detection | ✅ | Auto play/stop when the ROM polls the EAR port |
| Tape sound | ✗ | Tape is silent while loading (EAR is not wired to the buzzer) |
| Media persistence | ✅ | Mounted tapes come back after a reload |
| Border size | ✅ | None / small / normal crop of the fixed 320×240 frame |
| Status LEDs | ✅ | Keyboard, EAR, load, beep and TEXT |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | Shared Z80 debug service; memory and port watchpoints; Memory pane regions ROM, Video RAM, Char RAM, Main RAM and RAM pack; memory-map pane follows the fitted pack |
| Trace | ✗ | See Known issues |
| Screen OCR / TEXT overlay | ✅ | Reads the 32×24 screen file straight from video RAM (no font matching, so redefined characters do not matter); inverse cells are marked; block graphics read as spaces |
| Software library | ✗ | Not offered for this machine |
| BASIC tools / system-variables pane | — | FORTH machine; the sysvar, banks, font, drive, microdrive, joystick and mouse panes are hidden |
| On-screen keyboard | ✅ | 40 keys in the Spectrum 48K rubber-key arrangement with SYMBOL SHIFT characters, SHIFT functions and GRAPHICS blocks printed; SHIFT and SYMBOL SHIFT latch; keyboard lab preset under "Jupiter Cantab" |
| Host keyboard | ✅ | Left Shift = SHIFT; Right Shift and either Ctrl = SYMBOL SHIFT; Backspace/Delete = DELETE; arrows, Caps Lock and Escape (BREAK) map to SHIFT combinations; PC symbols are sent as SYMBOL SHIFT chords |
| MCP tools | ✅ | Generic tools: `model`, `load`, `eject`, `key`, `type`, `run`, `step`, `registers`, memory/port/breakpoint/watchpoint tools, `screenshot`, `ocr`. No Ace-specific tools. `save` (SZX) and `library` do not apply |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| Debugger trace control does nothing | `jupiter-ace` | low | The descriptor sets `trace: true`, so the Disassembly pane shows the trace menu, but `JupiterAceMachine.startTrace()` is an empty method ("Execution tracing is a later addition") and `stopTrace()` returns an empty string. The MCP `trace` tool declines on every non-Spectrum machine |

## Not emulated

- **Memory contention.** The real ULA steals cycles while it fetches the screen; no reference timing is published for the Ace's fetch pattern, so none is applied and the CPU runs uncontended.
- **Other RAM expansions.** Only the stock 3 KB, 16 KB pack and 48 KB pack are offered.
- **Sound chip, disk, snapshot, joystick, mouse, cartridge.** None exist on the Ace; the service surface returns null for disks and snapshots, and the shared AY object in the machine class is never wired to anything.
- **Tape audio during loading.** Playback is silent.
- **Execution trace.** See Known issues.

## Faithful quirks

- **Buzzer is a bus-access flip-flop.** Any write to an even port sets the buzzer and any read clears it, whatever the data byte holds; the ROM's `BEEP` loop alternates IN and OUT to make the tone, and there is no automatic key click.
- **Odd ports read 0xFF.** Only even ports reach the ULA.
- **Video and RAM chips mirror.** Each 1 KB chip repeats through its undecoded address lines (video RAM at 0x2000, character RAM at 0x2800, main RAM across 0x3000–0x3FFF).
- **0x2700 always reads 0**, even after a write; 0x2701–0x27FF is ordinary RAM (the PAD).
- **Open bus above 0x3FFF reads 0xFF** when no RAM pack is fitted, and writes are dropped; with the 16 KB pack the range above 0x7FFF is open bus.
- **/INT lasts eight scanlines, not a short pulse.** Matches the ULA's vertical-sync assertion; one interrupt is served per frame.
- **SHIFT+6 is cursor up and SHIFT+7 cursor down**, the reverse of the Spectrum; SHIFT+digit is an editing control, not a symbol.
- **`LOAD` is case-sensitive and unquoted.** A wrong-case name makes the ROM print `Dict:` and keep searching.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| `tests/jupiter-ace/ace-machine.test.ts`: ULA port 0xFE behaviour, video rendering, RAM pack option, tape turbo, /INT window, loader-detector auto-start, frame probe, OCR hook and memory regions | Pass | 2026-10-18 |
| `tests/jupiter-ace/ace-memory.test.ts`: ROM mapping, 1 KB chip mirrors, 0x2700 tie-off, 16K/48K pack mapping and reset behaviour | Pass | 2026-10-18 |
| `tests/jupiter-ace/ace-keyboard.test.ts`, `ace-keyboard-layout.test.ts`: matrix readout, combos, symbol chords, on-screen layout against the ROM's key-decode tables | Pass | 2026-10-18 |
| `tests/jupiter-ace/ace-tape.test.ts`, `ace-tape-playback.test.ts`: Ace `.tap` parsing, header tagging, pulse widths derived from the ROM `SAVE` routine and checked against the ROM loader's filters | Pass | 2026-10-18 |
| `tests/jupiter-ace/ace-tape-save.test.ts`: MIC edge recorder and decoding a captured `SAVE` back into a `.tap` | Pass | 2026-10-18 |
| `tests/jupiter-ace/ocr.test.ts`: screen-file transcription, inverse video, block graphics | Pass | 2026-10-18 |
| `tests/machines/tape-pause.test.ts` (Ace case): deck pause behaviour | Pass | 2026-10-18 |

No recorded reference results from real media or an external oracle.
