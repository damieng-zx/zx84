# Grundy NewBrain

Grundy Business Systems' compact Z80 microcomputer of 1982, built around a
COP420 microcontroller that does its keyboard, its sixteen-character
vacuum-fluorescent display and its two cassette motors. zx84 emulates the
unexpanded machine (the Model A and AD, which share a board) and runs the
COP420's own firmware, so the keyboard scan, the cassette timing and the
display protocol are the real ones rather than approximations.

| | |
| --- | --- |
| **Manufacturer** | Grundy Business Systems (designed by Newbury Laboratories) |
| **Released** | 1982 |
| **CPU** | Zilog Z80A — 4 MHz (16 MHz crystal ÷ 4); COP420 microcontroller at one instruction per 16 system clocks |
| **zx84 kind** | `newbrain` — [`src/machines/newbrain/`](../../src/machines/newbrain/) |
| **Model ids** | `newbrain` — the MCP `model` target and `?model=` value |
| **Accuracy** | Frame: the CPU and COP420 run line by line, the picture is drawn whole at the end of the 250th line from the registers latched at its start; no accuracy setting |
| **Status** | Boots to NEWBRAIN BASIC; keyboard, cassette load and save and the text and graphics display work against the real firmware; no disk, expansion or on-screen keyboard |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NewBrain (`newbrain`) | 1982 | 32 KB | 24 KB (3 × 8 KB), plus the COP420's 1 KB and a 4 KB character ROM | Discrete TTL: 40/80-column text, raw-byte graphics, 640 × 250 | None | Two cassette ports | The AD's VF display is always fitted; 4,000,000 / 50 = 80,000 T per frame |

### ROM sets

| Model | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| NewBrain | UK | `grundy/newbrain-a.rom`, `-cd.rom`, `-ef.rom` (8 KB each, A000 / C000 / E000), `-cop.rom` (1 KB COP420 firmware), `-char.rom` (4 KB character generator) | User-supplied until hosted |

The five images are joined in that order into one 29 KB system image
(`0x7400` bytes), which is what the ROM pane replaces and what a raw ROM drop
is classified by. The set in use is issue 3 (v1.91): `aben191`, `cdi3` and
`ef iss 1` from the common NewBrain ROM dumps. The C000 bank is identical in
every issue.

The COP420 firmware dump in circulation has two bit-2 dropouts, at `0x20A`
(`C2`, should be `C6`) and `0x231` (`A2`, should be `A6`); they are repaired
on load when, and only when, they hold the bad values.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| Z80A CPU | all | ✅ | Shared core [`src/cores/`](../../src/cores/); one IRQ line in interrupt mode 1 (the NMI is held off) |
| COP420 | all | ✅ | New core [`src/cores/cop420.ts`](../../src/cores/cop420.ts); the real firmware runs on it, wired by [`cop-board.ts`](../../src/machines/newbrain/cop-board.ts) |
| Video circuit | all | ✅ | [`newbrain-video.ts`](../../src/machines/newbrain/newbrain-video.ts): one byte per cell read from main RAM, glyph rows from the 4K character ROM, 8 dots a cell (16 wide in 40 columns), 250 lines |
| Keyboard | all | ✅ | 62-key matrix, 16 rows (Y0–Y15) × 4 columns (K3, K7, K8, K9), scanned by the COP420 |
| Cassette interface | all | ✅ | The COP420 serialises tape data (TDO out, SI in) and switches both motor relays; the OS reads the same input directly through the status register |
| VF display (AD) | all | ◐ | The COP420 is sent the 16 characters and shifts them out; zx84 keeps the digit latches (`NewBrainCopBoard.digits`) but has no pane drawing them yet |
| Clock interrupt | all | ✅ | 50 Hz, raised with the end of the picture, gated by bit 0 of the enable register (active low) and acknowledged by touching port 4 |
| Power-up timer | all | ✅ | About 5.6 ms after reset the top ROM bank stops shadowing the whole address space and RAM switches on |
| Expansion port, ACIA, CTC, user port, page register | — | ✗ | Not on the unexpanded Model A/AD |

### Memory map

| Range | Contents |
| --- | --- |
| `0000–7FFF` | RAM, 32 KB (shared with the video circuit) |
| `8000–9FFF` | Nothing fitted: reads `FF` |
| `A000–BFFF` | ROM A |
| `C000–DFFF` | ROM CD |
| `E000–FFFF` | ROM EF |

At power-up every address reads the E000 bank and RAM is off, so the Z80's
first fetch from `0000` finds the start-up code.

### I/O ports

Only A2–A4 (the group) and A0–A1 (the register) are decoded, so every port
repeats every 32.

| Port | Dir | Register |
| --- | --- | --- |
| `04` | R/W | CLCLK — any access acknowledges the clock interrupt |
| `06` | R/W | COP — read the COP420's Q register, write a byte to it (a write also clears G0, the interrupt request) |
| `07` | W | ENRG — enable register: bit 0 clock gate (low = interrupt allowed), bit 2 video on, bits 5–4 and 7–6 select what status bits 1 and 0 show |
| `08`/`0A` | W | TVL — write sets video address bit A6 (and reloads A7–A14) |
| `09`/`0B` | W | TVL — loads video address bits A7–A14 and drops A6 |
| `0C–0F` | W | TVCTL — bit 0 reverse video, bit 1 full 256-character set, bit 2 32/40, bit 3 upper character ROM (8-line rows, 31 rows), bit 6 80 columns |
| `14`/`15` | R | UST port A — bit 7 COP interrupt and bit 5 clock interrupt (both active low), bit 1 power-up flag or constant, bit 0 tape input or constant |
| `16`/`17` | R | UST port B — bit 5 tape input, serial lines idle |

---

## Peripherals

None. The expansion interface module (RAM paging, disk, CP/M), the user port
and the printer / V.24 interfaces are not modelled.

---

## Media formats

ZIP archives are accepted by the Load picker and routed as below.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.wav` | Tape | Tape deck | ✅ | ✅ | The NewBrain's tape format *is* audio; a recording is played through the pulse deck and the COP420 decodes it |
| `.csw` | Tape | Tape deck | ✅ | ✗ | |

A mounted tape is held until the OS switches a motor relay on (`LOAD`, with
PLAY already pressed on the real recorder); the relay is what starts and stops
the deck, exactly as the REM socket does on a real recorder. Pausing the deck
from the Tape pane overrides the relay.

**Save menu exports:** tape `.wav` (the COP420's tape-out line, timed and
rebuilt as a square wave; `newbrain-tape.wav`), PNG screenshot, RAM `.bin`
(`newbrain-ram.bin`, the 32 KB of RAM). A saved tape loads back into a fresh
machine.

There are no snapshot, disk or cartridge formats yet.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Timing | ◐ | The Z80 runs 80,000 T a frame over 312 lines; the COP420 is caught up after every Z80 instruction, so its host-bus handshakes are timed to within one instruction |
| Keyboard | ✅ | By character, not by key position: a host `"` is the NewBrain's SHIFT + 2 on any layout. SHIFT, CONTROL and GRAPHICS sit in the last row the COP420 scans, so a shifted key waits six frames behind its modifier |
| Fast / turbo loading | ✗ | The OS and COP420 time the tape themselves; the ordinary speed control applies |
| Display effects | ✗ | Monochrome, drawn per frame; the 32/40 border is read from the register but a border in text lines is not blanked |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | Z80 family service; the COP420 is not exposed to it |
| Trace | ✅ | Z80 execution trace |
| Screen OCR / TEXT overlay | ◐ | `ocr` reads the text straight out of RAM by the video circuit's own row rules; there is no TEXT overlay |
| Software library | ✗ | |
| Machine-specific panes | ✗ | No Hardware section or on-screen keyboard yet |
| MCP tools | ✅ | The generic set (`run`, `step`, `registers`, `read_memory`, `key`, `type`, `ocr`, `screenshot`, `load`, `save`, `trap`, …) |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| No on-screen keyboard, no VF display pane | UI | low | The COP420 does drive the display; nothing draws it yet |
| Keys without a verified function | Keyboard | low | Y0 K3 / K7 / K8, Y12 K3, Y14 K3 and Y15 K8 are unmapped: they have no entry in the ROM's decode tables that a typed character reaches |
| Text-line border in 32/40 mode | Video | low | The graphics window honours the border; text lines draw all `columns` cells |
| Tape recordings of the Z80's own bit-banged output | Tape | low | Only the COP420's tape-out line is recorded; the Z80's V.24 / printer transmit bits are not |

## Not emulated

- **Expansion Interface Module** — RAM paging up to 2 MB, the disk controller and CP/M. A program that pages RAM or probes the expansion bus finds nothing.
- **Sound** — the NewBrain has no loudspeaker the emulation knows of.
- **Battery power-down** — the Z80 `HALT` the OS uses to sleep waits for the next interrupt, which comes at once.
- **Model M / V variants** — the page register, ACIA, CTC and user port.

## Faithful quirks

- **Both interrupt status bits read low when pending.** Bit 7 (COP) and bit 5 (clock) of the status register are 0 while the interrupt is waiting; the OS tests them that way round.
- **The clock gate is active low.** Bit 0 of the enable register *disables* the 50 Hz interrupt when set; the OS keeps it clear.
- **COP420 pages 2 and 3 have no JSRP.** A `1xxxxxxx` opcode inside them (`0x080–0x0FF`) is a seven-bit `JP`, which is how the firmware's delay routines are written; reading them as calls overflows the three-level stack at once.
- **COP420 execution crosses page boundaries.** The firmware has a two-byte instruction in the last two bytes of a page whose successor is in the next one.
- **The video address counter loads a marker.** Each row starts two bytes (40 columns) or four (80 columns) into its 64- or 128-byte pitch.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| `tests/cores/cop420.test.ts` — the COP420 instruction set, stack, interrupts, serial and host bus | 64 tests pass | 2026-10-31 |
| `tests/newbrain/` — memory map, I/O decode, video, keyboard | Pass | 2026-10-31 |
| `tests/newbrain/newbrain-firmware.test.ts` — the real ROMs boot, take typed keys, run a BASIC program, and SAVE then LOAD it back | Pass (skipped without the ROM images) | 2026-10-31 |
