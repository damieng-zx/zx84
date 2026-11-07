# Commodore VIC-20

Commodore's 1980/81 6502-based home computer, the first computer to sell a million units. zx84 emulates the PAL machine (6561 VIC) and the NTSC one (6560 VIC): video and sound, both 6522 VIAs, expansion RAM, the Datasette, a drive-level 1541, 1571 or 1581 on the serial bus, cartridges and paddles.

| | |
| --- | --- |
| **Manufacturer** | Commodore Business Machines |
| **Released** | 1980 (Japan, as the VIC-1001), 1981 |
| **CPU** | MOS 6502 — 1.108405 MHz (PAL) or 1.022727 MHz (NTSC) |
| **zx84 kind** | `vic20` — [`src/machines/vic20/`](../../src/machines/vic20/) |
| **Model ids** | `vic20` — the MCP `model` target and `?model=` value. The TV standard is the locale, as on the C64: the model menu offers PAL and NTSC |
| **Accuracy** | Instruction-level CPU; the VIC is drawn lazily one cycle at a time, so mid-line register writes land where the beam is; VIA register accesses land on their own cycle. The VIC never holds the CPU. No user-selectable accuracy setting |
| **Status** | New: boots the real ROMs to BASIC, loads and saves tapes through the KERNAL, lists disks on a 1541, autostarts cartridges (see Verification) |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| VIC-20 PAL (`vic20`) | 1981 | 5 KB + 1 K × 4-bit colour RAM; expansion to 32 KB (+ BLK5) | 8 KB BASIC V2, 8 KB KERNAL (901486-07), 4 KB character ROM | 6561: 22 × 23 text by default, 8×8 or 8×16 characters, hi-res and multicolour | VIC: 3 square voices, noise, 4-bit volume | Datasette, 1541/1571/1581, cartridge | 312 lines × 71 cycles, 50.04 Hz |
| VIC-20 NTSC (`vic20`, locale `us`) | 1981 | As PAL | KERNAL 901486-06 | 6560: 261 lines × 65 cycles | As PAL | As PAL | 60.28 Hz. Snapshots remember their standard and refuse the other |

### ROM sets

Each ROM is a file of its own on the ROM host and has its own socket in the ROM pane. A 20 KB image (BASIC, KERNAL and the character ROM at an 8 KB stride) dropped on any socket fills all three.

| Socket | File | Size | Notes |
| --- | --- | --- | --- |
| BASIC | `vic20/basic-901486-01.rom` | 8 KB | `$C000`–`$DFFF` |
| KERNAL | `vic20/kernal-901486-07.rom` (PAL), `vic20/kernal-901486-06.rom` (NTSC) | 8 KB | `$E000`–`$FFFF` |
| Character ROM | `vic20/characters-901460-03.rom` | 4 KB | `$8000`–`$8FFF`; the VIC sees it at its `$0000` |
| 1541 / 1571 / 1581 DOS | The C64's files (`c64/dos…`) | 16 / 32 / 32 KB | Shared with the C64, same cache. A socket only while that drive is fitted |

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| MOS 6502 CPU | all | ✅ | [`src/cores/m6502.ts`](../../src/cores/m6502.ts) |
| Memory map | all | ✅ | [`memory.ts`](../../src/machines/vic20/memory.ts). 1 KB at `$0000` and 4 KB at `$1000` on the board; RAM1-3 (`$0400`), BLK1-3 (`$2000`-`$7FFF`) and BLK5 (`$A000`) from the expansion port. Empty places read what the VIC last left on the data bus, as does the top nybble of colour RAM |
| VIC 6561 / 6560 (video) | all | ◐ | [`vic.ts`](../../src/machines/vic20/vic.ts). Text area from the origin, column/row and address registers; 8×8 and 8×16 characters; hi-res, reverse mode and multicolour (border, background, character and auxiliary colours); raster register. The VIC's 14-bit view (its A13 is CPU A15 inverted) sees only the character ROM and the board's RAM. A character's pixels come out on the two cycles it is fetched in: the chip's own pipeline delay is not modelled. Light pen and interlace are not |
| VIC (sound) | all | ◐ | [`vic-sound.ts`](../../src/machines/vic20/vic-sound.ts). Bass, alto and soprano at clock / (256, 128, 64) / (128 − X) (the Programmer's Reference Guide's constants), each a 7-bit counter into an 8-bit Johnson shift register; noise from a 16-bit LFSR; the volume makes a level on its own, so volume-register samples play. The noise sequence is not the chip's measured one |
| VIA 1 (`$9110`, NMI) | all | ✅ | [`src/cores/m6522.ts`](../../src/cores/m6522.ts). Serial CLK/DATA in, joystick up/down/left/fire, cassette sense, ATN out; RESTORE on CA1, cassette motor on CA2 |
| VIA 2 (`$9120`, IRQ) | all | ◐ | Keyboard matrix (columns on port B, rows on port A), joystick right on PB7, cassette write on PB3 and read on CA1, serial CLK/DATA out on CA2/CB2. Timer 1's free-running period is the shared core's latch + 1, where the 6522's is latch + 2 |
| Keyboard | all | ✅ | The C64's 66 keys on the VIC-20's own matrix (the KERNAL's scan table); RESTORE (host `PageUp`) is NMI. The Keyboard pane is the C64's breadbin, shared |
| Joystick port | all | ✅ | One port, split across the two VIAs. Holding right pulls keyboard column 7, as on the real machine |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Expansion RAM | Memory | all | ✅ | Hardware pane: Unexpanded, 3K, 8K, 16K, 24K, 3K + 24K, and RAM at BLK5. A power cycle. Dropping a program fits the RAM its load address asks for |
| Datasette | Tape | all | ✅ | The shared Commodore deck: a mounted tape counts as PLAY, the motor moves it, auto-PLAY when PRESS PLAY ON TAPE polls, turbo while the KERNAL reads or writes. An empty deck is RECORD + PLAY, so SAVE just works and the result can be downloaded as a VIC-20 `.tap` |
| Commodore 1541 / 1571 / 1581 | Disk | all | ✅ | The C64's drive-level drives, shared (`shared/cbm/`): up to four, devices 8-11, on the serial bus (ATN from VIA 1 PA7, CLK/DATA through inverters from VIA 2 CA2/CB2, read back on VIA 1 PA0/PA1). Hardware pane checkbox, Drives pane models |
| Cartridges | Expansion port | all | ✅ | ROM in BLK1-3 and BLK5, ahead of any RAM there; the KERNAL autostarts one with "A0CBM" at `$A004`. Plugging one in or out is a power cycle. Kept across a reload; carried by snapshots |
| Paddles | Input | all | ◐ | Mouse pane: the mouse turns POT X/Y (`$9008`/`$9009`); the buttons are on the joystick left and right lines. Moving right lowers the value, as a paddle turned clockwise does (not checked against a real paddle) |

**Combination rules:** cartridge ROM wins over expansion RAM in the same block.

---

## Media formats

ZIP archives are unpacked; the first loadable entry is mounted, with a picker when there are several.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.tap` | Tape | Datasette | ✅ | ✅ | Commodore TAP v0/v1; pulses timed in the clock the header names (a VIC-20 tape's own, a C64 tape's own). Tapes made from a `.prg`/`.t64` use the VIC-20 KERNAL's own pulse lengths (TAP bytes $2C/$40/$54, against the C64's $30/$42/$56) |
| `.prg` | Program | Memory + Datasette | ✅ | — | Put in memory as LOAD leaves it and RUN; also taped. One at `$A000` with "A0CBM" is a cartridge |
| `.t64` | Program | Memory + Datasette | ✅ | — | Its first program, as `.prg` |
| `.d64` `.g64` `.d71` `.d81` | Disk | Drive 8-11 | ✅ | ✅ | As on the C64 |
| `.crt` | Cartridge | Expansion port | ✅ | — | VICE "VIC20 CARTRIDGE", generic type 0 only |
| `.a0` `.20` `.40` `.60` | Cartridge | Expansion port | ✅ | — | Raw ROM for the block named, with or without a load address. 4K images repeat in their block |
| `.vic20state` | Snapshot | Machine | ✅ | ✅ | zx84's native state |

**Save menu exports:** snapshot, saved tape, screenshot, RAM dump.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Raster effects | ◐ | Register writes take effect from the beam's cycle; fetch-to-pixel delay not modelled |
| Fast tape loading | ✅ | Turbo while the KERNAL reads or writes the tape, or a drive works |
| Program autostart | ✅ | `.prg`/`.t64` waits for READY., then loads and types RUN |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | The 6502 family debug service |
| Trace | ✅ | Full and port I/O (the `$9000`-`$93FF` block) |
| Screen OCR / TEXT overlay | ✅ | Codes matched against the ROM glyphs, over the VIC's own text area |
| BASIC listing and variables | ✅ | BASIC V2, as the C64's |
| Memory map pane | ✅ | Blocks as RAM, cartridge ROM or empty; screen, character and colour addresses |
| Chip dump | ✅ | `vic`, `via1`, `via2`, `drive`… |
| MCP tools | ✅ | The generic ones; `type` takes characters as on the C64 |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| VIA timer 1 period | all | low | Latch + 1 in the shared core (latch + 2 on the chip): the jiffy runs a cycle a period fast |
| VIC pipeline | all | low | Characters drawn on their fetch cycles; the visible window placed around the KERNAL's defaults, not measured |

## Not emulated

- Light pen, interlace, user port, RS-232.
- Banked cartridges (Mega-Cart, Final Expansion) and the Super Expander's RAM.
- The VIC-1001's Japanese character ROM.

## Faithful quirks

- Expansion RAM is invisible to the VIC: a screen can only be in the board's RAM, which is why the KERNAL moves it to `$1000` with 8K or more.
- With 8K or more fitted, the 3K block is left out of BASIC.
- Joystick right pulls keyboard column 7: holding it reads as some keys being down.
- PB3 is both keyboard column 3 and the cassette write line, so a SAVE's recording starts with a few short bursts from the keyboard scan, before the KERNAL takes over the interrupt and writes the leader.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| `tests/vic20/` (synthetic firmware: memory map, I/O decode, keyboard against the KERNAL table, interrupts, VIC rendering, sound, programs, tape, serial bus, cartridges, OCR, snapshots) | Pass | 2026-11-05 |
| Real-ROM tests in `tests/vic20/` (VICE's copies of 901486-01, -06, -07, 901460-03 and the 1541 DOS): boot to READY; bytes free with each expansion (3583, 6655, 11775, 19967, 28159); typing and RUN; KERNAL SAVE then LOAD; LOAD of a dropped program's tape; `LOAD"$",8` on a 1541; cartridge autostart | Pass | 2026-11-05 |
