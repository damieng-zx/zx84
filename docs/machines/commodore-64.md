# Commodore 64

Commodore's 1982 6510-based home computer, the best-selling single computer model of all time. zx84 emulates the PAL machine with a cycle-stolen VIC-II, the 6581 SID, both CIAs, the Datasette and a drive-level 1541 disk drive that runs the real DOS ROM.

| | |
| --- | --- |
| **Manufacturer** | Commodore Business Machines |
| **Released** | 1982 |
| **CPU** | MOS 6510 (a 6502 with an I/O port at `$00`/`$01`) — 0.985248 MHz (PAL) |
| **zx84 kind** | `c64` — [`src/machines/c64/`](../../src/machines/c64/) |
| **Model ids** | `c64` — the MCP `model` target and `?model=` value |
| **Accuracy** | Instruction-level CPU; the VIC-II is drawn lazily one cycle at a time, and bad-line and sprite DMA hold the CPU at instruction granularity (an instruction overtaken part-way is stretched). CIA timers are advanced arithmetically; register accesses land on their own cycle. No user-selectable accuracy setting |
| **Status** | Working — boots the real ROMs to BASIC, loads tapes and disks; see Verification |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Commodore 64 PAL (`c64`) | 1982 | 64 KB + 1 KB colour RAM | 8 KB BASIC V2, 8 KB KERNAL, 4 KB character ROM | 6569 VIC-II, 40 × 25 text, bitmap, multicolour, ECM, 8 sprites | 6581 SID, 3 voices | Datasette, 1541 disk drive (device 8) | PAL only: 312 lines × 63 cycles |

### ROM sets

Each ROM is a file of its own on the ROM host and has its own socket in the ROM pane, so any one can be replaced without the others. A 20 KB whole image (BASIC + KERNAL + character ROM end to end) dropped on any socket fills all three.

| Socket | File | Size | Notes |
| --- | --- | --- | --- |
| BASIC | `c64/basic-901226-01.rom` | 8 KB | `$A000`–`$BFFF` |
| KERNAL | `c64/kernal-901227-03.rom` | 8 KB | `$E000`–`$FFFF` |
| Character ROM | `c64/chargen-901225-01.rom` | 4 KB | Seen by the VIC-II at `$1000`/`$9000`, and by the CPU at `$D000` when banked in |
| 1541 DOS | `c64/dos1541-325302-01-901229-05.rom` | 16 KB | 325302-01 at `$C000`, 901229-05 at `$E000`. A socket only while the drive is fitted |

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| MOS 6510 CPU | all | ✅ | [`src/cores/m6502.ts`](../../src/cores/m6502.ts) plus the I/O port and PLA banking in [`memory.ts`](../../src/machines/c64/memory.ts). The read-modify-write dummy write reaches I/O (an `INC $D019` acknowledges the VIC-II) |
| VIC-II 6569 | all | ◐ | [`vic-ii.ts`](../../src/machines/c64/vic-ii.ts), after Christian Bauer's *The MOS 6567/6569 video controller (VIC-II)*. Standard and multicolour text and bitmap, extended-colour text, sprites (expansion, multicolour, priority, collisions), border flip-flops and the 38/24-line windows, scrolling, raster IRQ. Bad lines hold the CPU for 43 cycles, sprite DMA steals its slots. Light pen is not wired |
| SID 6581 | all | ◐ | [`src/cores/mos6581.ts`](../../src/cores/mos6581.ts). Three voices with all four waveforms, ADSR with the rate counter's quirks, sync and ring modulation, the state-variable filter modelled on the 6581's measured cutoff curve. POTX/POTY read full scale (nothing connected); no 8580 |
| CIA 6526 × 2 | all | ✅ | [`src/cores/mos6526.ts`](../../src/cores/mos6526.ts). Both timers (continuous, one-shot, PB6/PB7 output, timer B counting timer A), interrupt control, BCD time of day with alarm, serial register. CIA 1: keyboard matrix, joysticks, cassette FLAG, IRQ. CIA 2: VIC bank, serial bus, NMI |
| Keyboard | all | ✅ | 8 × 8 matrix scanned through CIA 1 from the host keyboard. RESTORE is not in the matrix: it pulls NMI (host key `PageUp`) |
| Datasette | all | ✅ | See Peripherals |
| Joystick ports | all | ✅ | Two ports on CIA 1; each player picks the port its stick is in. Player 1 starts in port 1, player 2 in port 2 |
| User port, RS-232, expansion port | all | ✗ | See Not emulated |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Datasette (tape) | Tape | all | ✅ | Edge-timed through CIA 1's FLAG input. A mounted tape has PLAY down; the motor (port bit 5) moves it. An empty deck counts as RECORD + PLAY, so `SAVE` just works and the result can be downloaded. Turbo loading follows CIA 1 ICR reads and write-line activity. Dropping a `.prg` or `.t64` also mounts a generated KERNAL-format tape of it, so the Tape pane shows its name and blocks and `LOAD` finds it |
| Commodore 1541 | Disk | all | ✅ | **Drive-level, not a KERNAL trap.** The drive is its own 6502 at 1 MHz with 2 KB RAM, the DOS ROM and two 6522 VIAs (VIA 1 the serial bus, VIA 2 the disk controller), turning a GCR track under the head at the real speed-zone bit rates, stepper and motor included. It is connected to the 64 through a modelled IEC bus (open-collector CLK/DATA/ATN) and brought up to the 64's clock at every `$DD00` access and at frame end. Fitted by default; the Hardware pane's **1541 disk drive** checkbox removes it (and the ROM pane's 1541 DOS socket with it). One drive, device 8 |
| Joystick | Input | all | ✅ | Control port 1 or 2 per player (Joystick pane) |

**Combination rules:** none; the drive is optional and independent of the tape.

---

## Media formats

ZIP archives are unpacked; the first loadable entry is mounted, with a picker when there are several.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.tap` | Tape | Datasette | ✅ | ✅ | C64 TAP (pulse lengths in 8-cycle units, v0 and v1). Save downloads what the KERNAL has SAVEd to tape |
| `.t64` | Program | Datasette | ✅ | — | Injected and run (VICE-style autostart: resets, loads, types `RUN`); a generated tape is mounted as well |
| `.prg` | Program | Datasette | ✅ | — | As `.t64` |
| `.d64` | Disk | Drive 8 | ✅ | ✅ | 35, 40 or 42 tracks, with or without the trailing error bytes (kept, and read back as the matching disk errors). Saved as `.d64` when every sector can still be read from the GCR, otherwise as `.g64` |
| `.g64` | Disk | Drive 8 | ✅ | ✅ | `GCR-1541` v0: per-half-track bit streams and speed zones. Odd-length tracks, half tracks and custom speeds survive, so copy protections that depend on them still see them |
| `.c64state` | Snapshot | Machine | ✅ | ✅ | zx84's own exact save state, including the drive (its CPU, VIAs and the disk) when one is fitted |

**Save menu exports:** snapshot (`.c64state`), tape (`.tap`), screenshot (PNG), RAM (`.bin`).

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Tape auto-PLAY and turbo | ✅ | PLAY is pressed for you when the KERNAL polls the tape port; load time shrinks with the turbo setting |
| Disk turbo | ✅ | Runs flat out while the drive is busy, as the tape does |
| Drive LED and sounds | ◐ | LED, motor and head track in the status bar and Drives pane; the shared floppy sound (5.25-inch motor and head steps, when floppy sounds are on) follows the motor and track. Not listened to |
| Border size | ✅ | Normal, small, none |
| Colour map | — | The sixteen VIC-II colours are fixed |
| Programs in the Library | ✗ | No library for the 64 |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | The 6502 family service, with the full 64K the CPU sees (ROM and I/O as banked) |
| Trace | ✅ | Full and port-I/O modes |
| Beam debugging | ✅ | `beam_log`, `interrupt_log` and `run` with `until_line`: 312 lines × 63 cycles per frame |
| Screen OCR / TEXT overlay | ◐ | Character modes only: reads the VIC-II's view of screen and character RAM and matches glyphs against the ROM font in both sets, including reverse video, extended-colour text and a scrolled display. Multicolour cells and bitmap modes read as nothing |
| BASIC Listing / Variables panes | ✅ | BASIC V2, read from RAM through the zero-page pointers (`$2B` `$2D` `$2F` `$31`): the detokenised program (control codes spelled as `petcat` does: `{clr}`, `{red}`), simple variables (reals as BASIC prints them, integers, strings), arrays with their dimensions, and FOR loops in progress with their TO and STEP |
| Machine-specific panes | ✅ | Memory map (banking, VIC bank, screen base), Tape, Drives, Joystick, Hardware. Microdrive, mouse, system-variable and font panes are hidden |
| MCP tools | ✅ | The generic tools (`registers`, `step`, `disassemble`, `memory`, `trace`, `beam_log`, `ocr`, `screenshot`, `type`, `key`, `load`, `eject`) plus `chip_state` (`vic`, `sid`, `cia1`, `cia2`, `pla`, and `drive` while one is fitted) and `c64drive` (`on`, `off`, `status`). `type` enters the character the key makes, so `LOAD""` is typed as written |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| No real-time check of audio or typing in the browser | SID, keyboard | low | Verified headlessly (frame-driven) and by tests; the SID has not been listened to by a person |
| Idle drive costs about 12% of emulation speed | 1541 | low | The drive's 6502 and VIAs run in lock-step; 19× real time instead of 21× when idle |

## Not emulated

- NTSC (6567/6566) timing and the 6567R56A/R8 differences — PAL only.
- Cartridges (`.crt`), the expansion port, REU and fast-loader cartridges.
- User port and RS-232; the light pen; paddles (POT lines read as full scale).
- 8580 SID.
- Datasette sound.
- Other drives: 1541-II, 1570/1571, 1581 (`.d81`), 2031/4040 and the third-party drives. There is one 1541 at device 8; `.d71`, `.d81`, `.x64` and `.p00` are not read.
- C128 and VIC-20 (separate machines, not part of this one).

## Faithful quirks

- **Bad-line hold is 43 cycles** — the VIC-II takes the bus for cycles 11–54 of a bad line and the CPU is stopped for the whole window (not twice, which an earlier version charged); the serial-bus loops in the 1541 transfer code depend on it.
- **DATA is held low by hardware** — when ATN and ATNA disagree the 1541's gate pulls DATA low before any firmware runs; that is how the drive "answers" ATN.
- **The write-protect sensor flickers on a disk change** — for about 40,000 drive cycles after a disk goes in or out the sensor reads the opposite of its final value, so the DOS notices the change.
- **Formatting takes about 80 seconds** — `OPEN 15,8,15,"N:NAME,ID"` really formats all 35 tracks and writes them out.
- **`PI` is a variable** — the 64 has no `PI` keyword (`SHIFT`+`↑` types π), so `P=PI` lists, and runs, as a variable named `PI`.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| [`tests/c64/c64-machine.test.ts`](../../tests/c64/c64-machine.test.ts) | PLA banking, the VIC-II bad-line hold and raster IRQ, exact snapshot restore, boot to BASIC V2 with the real ROMs, typing and running a program, dropped `.prg` starting fresh and landing on the tape, KERNAL `SAVE` → `LOAD` round trip | 2026-10-28 |
| [`tests/c64/c64-1541.test.ts`](../../tests/c64/c64-1541.test.ts) | The drive against the real DOS ROM: `LOAD"$",8` (name, ID, blocks free), `LOAD` and `RUN`, `SAVE` and reload with a clean `.d64` export, `N:` format, disk swap including `.g64`, eject error, exact snapshot restore; the 43-cycle bad-line hold; head, stepper, sync and byte-ready mechanics | 2026-10-28 |
| [`tests/c64/c64-disk.test.ts`](../../tests/c64/c64-disk.test.ts) | D64/G64 parse and serialise, GCR encode/decode, error bytes, export choice | 2026-10-28 |
| [`tests/c64/c64-chips.test.ts`](../../tests/c64/c64-chips.test.ts) | `chip_state` dumps: VIC-II decode, SID pitch and waveform, CIA timers and bus lines, the drive; dumping changes nothing | 2026-10-29 |
| [`tests/basic/c64-basic-parser.test.ts`](../../tests/basic/c64-basic-parser.test.ts) | Listing, variables, arrays and FOR frames against what the real BASIC leaves in RAM | 2026-10-29 |
| [`tests/c64/c64-ocr-joystick.test.ts`](../../tests/c64/c64-ocr-joystick.test.ts) | TEXT overlay on the boot screen and a `LIST`, joystick port defaults | 2026-10-28 |
| [`tests/c64/mos6526.test.ts`](../../tests/c64/mos6526.test.ts), [`mos6581.test.ts`](../../tests/c64/mos6581.test.ts) | CIA timers, ICR, time of day; SID voice 3 read-back, TEST, noise and envelope | 2026-10-28 |

Tests that need the Commodore ROMs read them from `mcp/.cache` (the copies from VICE) and skip when absent.
