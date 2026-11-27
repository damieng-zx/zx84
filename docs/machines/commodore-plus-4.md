# Commodore Plus/4 and Commodore 16

Commodore's 1984 answer to the Spectrum and the BBC Micro, and the machine that
introduced the "264 series" motherboard: a 7501 (a 6502 with an I/O port) and
one custom chip, the 7360 TED, which does video *and* sound and also drives the
memory bus. zx84 emulates the Plus/4 (64K, the "3+1" function ROMs, the RS-232
port) and the Commodore 16 (16K, no ACIA) as two models of the same board, with
the TED's four display modes, its two square-wave voices, the 6529B user port,
the 6551A ACIA, the ROM banking that gives BASIC 60K of RAM, the Datasette and
the 1541/1571/1581 on the serial bus.

| | |
| --- | --- |
| **Manufacturer** | Commodore Business Machines |
| **Released** | 1984 (the C16 and Plus/4; the C116 followed) |
| **CPU** | MOS 7501 at 1.773447 MHz (PAL) or 1.789772 MHz (NTSC) |
| **zx84 kind** | `plus4` — [`src/machines/plus4/`](../../src/machines/plus4/) |
| **Model ids** | `plus4`, `c16` — the MCP `model` target and `?model=` value. The TV standard is the locale: the model menu offers PAL and NTSC |
| **Accuracy** | Instruction-level CPU; the TED draws a line a pixel span at a time as the beam passes, and holds the CPU off the bus for 88 cycles of a bad line. Register writes land on the cycle of the instruction they fall on, and a picture register written mid-line changes the display from that cycle. No user-selectable accuracy setting |
| **Status** | Working — boots the real ROMs to BASIC 3.5, types and runs programs; the display, sound, tape, drives and cartridges are in |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Commodore Plus/4 (`plus4`) | 1984 | 64 KB | 16K KERNAL, 16K BASIC 3.5, two 16K "3+1" function ROMs | 7360 TED: 40×25 text, multicolour text, extended background, hires and multicolour bitmap | TED: two square voices, noise, 4-bit volume, D/A mode | Datasette, 1541/1571/1581 on the serial bus, cartridge | 312 lines × 114 cycles, 49.8 Hz; the 6551A ACIA and the user port are fitted |
| Commodore 16 (`c16`) | 1984 | 16 KB (mirrored four times) | 16K KERNAL, 16K BASIC 3.5 | as the Plus/4 | as the Plus/4 | Datasette, drives, cartridge | No ACIA, no user port; 262-line NTSC and 312-line PAL frames as the Plus/4 |

### ROM sets

Each ROM is a file of its own on the ROM host and has its own socket in the ROM
pane, so any one can be replaced without the others. A whole image dropped on any
socket fills every socket.

| Socket | File | Size | Notes |
| --- | --- | --- | --- |
| KERNAL | `plus4/kernal-318004-05.rom` (PAL) / `kernal-318005-05.rom` (NTSC) | 16K | `$C000`-`$FFFF` when the bank select names it |
| BASIC | `plus4/basic-318006-01.rom` | 16K | `$8000`-`$BFFF`; BASIC 3.5 |
| 3+1 low | `plus4/3plus1-317053-01.rom` | 16K | Plus/4 only: `$8000`-`$BFFF` when bank 1 is selected |
| 3+1 high | `plus4/3plus1-317054-01.rom` | 16K | Plus/4 only: `$C000`-`$FFFF` |
| 1541 DOS | `c64/dos1541-325302-01-901229-05.rom` | 16K | A socket only while a 1541 is fitted |
| 1571 DOS | `c64/dos1571-310654-05.rom` | 32K | A socket only while a 1571 is fitted |
| 1581 DOS | `c64/dos1581-318045-02.rom` | 32K | A socket only while a 1581 is fitted |

The character set is inside the KERNAL image (the TED reads it through the same
banked map), so it is not a socket of its own.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| MOS 7501 CPU | all | ✅ | [`src/cores/m6502.ts`](../../src/cores/m6502.ts) plus the I/O port at `$00`/`$01` (the serial bus, the cassette) in [`memory.ts`](../../src/machines/plus4/memory.ts). A read-modify-write's dummy write reaches I/O |
| 7360 TED | all | ◐ | [`ted.ts`](../../src/machines/plus4/ted.ts). All four display modes (standard text, multicolour text, hires bitmap, multicolour bitmap) plus extended-background text, the 24/25-row and 38/40-column modes, X/Y scroll, reverse video, the hardware cursor with its flash, the three timers, the raster compare interrupt and the light-pen register. The picture is drawn a line at a time, and a bad line (the line whose low three raster bits match YSCROLL + 1, which the KERNAL's YSCROLL 3 puts at the start of every character row) holds the CPU off the bus for 88 of the 114 cycles. YSCROLL only decides when a row's matrix is fetched: the glyph line is the chip's own free-running counter, so the picture never rotates. The overscan is `$FF19` and the paper under the display window `$FF15`. Register writes land on the cycle of the instruction, and the picture is painted as the beam passes, so a display register written part-way through a line changes the rest of that line. The illegal modes paint the screen black |
| TED sound | all | ◐ | [`ted-sound.ts`](../../src/machines/plus4/ted-sound.ts). Two square voices each dividing the clock by 8 by `frequency + 1`, a 10-bit frequency, the noise shift register clocked by voice 2, the 4-bit volume (8-15 the same as 8) and the D/A mode the KERNAL's speech players use. Frequency `$3FE` and above is silence, as on the chip |
| 6529B PIO × 2 | all | ✅ | [`src/cores/m6529b.ts`](../../src/cores/m6529b.ts). PIO 1 (`$FD10`) is the user port with the cassette's PLAY line on bit 2; PIO 2 (`$FD30`) drives the keyboard matrix lines. The board wires PIO 2's direction lines as outputs, so it is a plain latch |
| 6551A ACIA | `plus4` | ◐ | [`src/cores/mc6551.ts`](../../src/cores/mc6551.ts). The four registers at `$FD00`-`$FD03`, mirrored through the page: data, status (with TDRE, RDRF, overrun, the DSR/DCD handshake bits and IRQ), command and control (including the baud divisor). A transmitted byte holds TDRE clear for its frame (start, data, parity and stop bits at two cycles a bit times the divisor) and a received byte becomes available after its frame; nothing is connected to the socket, so the modem's handshake bits are the board's and line noise is not modelled |
| Keyboard | all | ✅ | An 8 × 8 matrix scanned with the TED and PIO 2, from the host keyboard. The cells are the board's real key positions (the function keys carry both halves on one cap, and the four cursor keys are their own caps). There is no RESTORE key: the RESET button is hardware. The Keyboard pane is the shared breadbin face driving `PLUS4_MATRIX` |
| ROM banking | all | ✅ | `$FDD0`-`$FDDF` selects a ROM pair for `$8000-$BFFF` and `$C000-$FFFF`: BASIC and the KERNAL, the two 3+1 ROMs, or a cartridge. `$FF3F` banks the ROMs out altogether, which is how BASIC gets 60K; a write to a ROM bleeds through to the RAM under it |
| 256K expansion | all | ✅ | The Hannes/Solder board's four 64K banks at `$FD16` (bank bits 0-1, the `$1000`/`$4000` switch bound in bit 7, and bit 6 for whether the TED follows the CPU bank), and the CSORY board's 16K block in the window `$FD15` names. Chosen in the Hardware pane |
| Datasette | all | ✅ | See Peripherals. Its EAR line is mixed into the audio as the loading sound when the tape runs, gated by the Tape pane's "Loading sounds" setting |
| Joystick ports | all | ✅ | Two control ports read through the TED's keyboard register, as on the C64 |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Datasette (tape) | Tape | all | ✅ | The 7501's port carries it: bit 4 is the read line, bit 3 the motor (low = on), bit 1 the write line, and PIO 1 bit 2 is the PLAY sense. A mounted tape has PLAY down; the motor moves it; the read line's falling edges drive the TED's timer 1 interrupt. Tapes are the C16's half-wave format (VICE `.tap` version 2): the KERNAL times both halves of every dipole and carries a bit in which half is short, so a `.prg` or `.t64` dropped on the machine is written as a version-2 recording the KERNAL can LOAD. Turbo follows the TED's status-register reads and the write line |
| Commodore 1541 / 1571 / 1581 | Disk | all | ✅ | The shared drive-level model on the shared open-collector serial bus, bit-banged on the 7501's port (ATN bit 7, CLK bit 6, DATA bit 5 out, the two line levels back on the same bits). Up to four drives, devices 8 to 11, each chosen in the Drives pane. The DOS ROMs share the C64's files and cache |
| Cartridges | Expansion port | all | ✅ | Plain `.crt`/`.bin` ROMs, and the banked boards: the c264 magic cart (128K-2MB, bank at `$FDFE`), the Plus/4 multi cart (2MB/4MB, bank at `$FDA0`) and the JACINT 1MB (64 banks, bank at `$FE00`); a raw `.bin` of 16K, 32K or 64K is placed from `$8000` up. The Speedy freezer (type 4) is refused. The `$FDD0` bank select decides which window answers. Fitting or ejecting one is a power cycle, and snapshots carry it |
| Joystick | Input | all | ✅ | Control port 1 or 2 per player (Joystick pane). Nothing analogue: the TED has no paddle inputs |

**Combination rules:** none; the drive is optional and independent of the tape.

---

## Media formats

ZIP archives are unpacked; the first loadable entry is mounted, with a picker when
there are several.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.tap` | Tape | Datasette | ✅ | ✅ | "C64-TAPE-RAW" with platform 2 (the C16/Plus/4), version 2: one entry per half-wave, both halves of every dipole timed, as the C16 KERNAL writes it. Save downloads a version-2 tape of what the KERNAL has SAVEd |
| `.t64` | Program | Datasette | ✅ | — | Injected and run (resets, loads, types `RUN`); a generated tape is mounted as well |
| `.prg` | Program | Datasette | ✅ | — | As `.t64`, at either of BASIC 3.5's two starting places (`$1001`, or `$4001` with a graphics area) |
| `.d64` / `.g64` / `.g41` | Disk | A 1541 (device 8-11) | ✅ | ✅ | The shared GCR formats |
| `.d71` | Disk | A 1571 | ✅ | ✅ | Both sides of a 5.25" disk |
| `.d81` | Disk | A 1581 | ✅ | ✅ | 3.5" 800K disks |
| `.crt` / `.bin` | Cartridge | Expansion port | ✅ | — | Plain ROM chips, the magic cart, the multi cart and the JACINT 1MB; or a raw ROM image from `$8000` up |
| `.plus4state` | Snapshot | Machine | ✅ | ✅ | zx84's own exact save state, including the drive (its CPU, its chips and the disk) and the cartridge |

**Save menu exports:** snapshot (`.plus4state`), tape (`.tap`), screenshot (PNG), RAM (`.bin`).

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Bad-line bus hold | ✅ | 88 of a line's 114 cycles on the line the TED fetches a character row on; the raster compare interrupt is timed to it |
| Display modes | ✅ | Standard, multicolour and extended-background text, hires and multicolour bitmap; 24/25 rows, 38/40 columns, X/Y scroll, reverse video |
| 1 MHz mode | ✅ | The `$FF13` bit 1 clock is modelled: the CPU runs at half the TED's clock while video, sound and the timers keep their own, so a frame still takes 114×312 TED cycles and the CPU gets half as many of them. A write to the register takes effect from the next instruction |
| Tape auto-PLAY and turbo | ✅ | PLAY is pressed when the KERNAL polls the sense line; load time shrinks with the turbo setting |
| Disk turbo | ✅ | Runs flat out while a drive's motor is on and its controller or the serial bus is moving bytes |
| Border size | ✅ | Normal, small, none |
| Colour map | — | The TED's 128 colours are fixed (see [`palette.ts`](../../src/machines/plus4/palette.ts)) |
| Programs in the Library | ✗ | No library for the Plus/4 |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | The 6502 family service, over the whole 64K the CPU sees |
| Trace | ✅ | Full and port-I/O modes |
| Beam debugging | ✅ | `beam_log`, `interrupt_log` and `run` with `until_line`: 312 lines × 114 cycles a frame (262 × 114 on NTSC) |
| Screen OCR / TEXT overlay | ◐ | Character modes, multicolour text and the hires bitmap: the character modes read the video matrix and match each code's glyph against the set the TED is fetching through; the hires bitmap matches each 8×8 tile against the same glyphs, in either video. The multicolour bitmap's cells are half-width, so they are not read yet |
| BASIC Listing / Variables panes | ✅ | BASIC 3.5 keeps V2's zero-page pointers and line layout, so the variable reader is the C64's. The listing uses BASIC 3.5's own keyword table (`$80`-`$FD`, from the BASIC ROM at `$818E`): the V2 set plus RGR/RCLR/RLUM, the structured statements, the TED graphics and sound commands and the disk commands. There are no `$CE`/`$FE` escapes in 3.5 — those are BASIC 7.0 |
| Machine-specific panes | ✅ | Memory map (the ROM banks, the RAM mode), Tape, Drives, Joystick, ROM / Carts, Keyboard, Hardware. Microdrive, system-variable and font panes are hidden |
| MCP tools | ✅ | The generic tools (`registers`, `step`, `disassemble`, `memory`, `trace`, `beam_log`, `ocr`, `screenshot`, `type`, `key`, `load`, `eject`) plus `chip_state` (`ted`, `pio1`, `pio2`, `acia`, `drive`) |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| No line-noise errors on RS-232 | RS-232 | low | The ACIA times its frames and flags an overrun, but there is no modem or printer on the socket to deliver a malformed frame, so the parity and framing error bits never set. The KERNAL's RS-232 routines poll the flags they need |
| No real-time check of sound | TED sound | low | Verified headlessly and by unit tests; the two voices have not been listened to |
| Idle drives cost emulation speed | 1541, 1571, 1581 | low | As on the C64: each drive runs its own 6502 and chips in lock-step |

## Not emulated

- The light pen, and the 1551's parallel-bus TIA (only the serial drives).
- The speech chip of the V364 prototype.
- The Speedy freezer cartridge (hardware type 4) and the SIDcard.

## Faithful quirks

- **A latch of 0 counts a whole 65536 ticks** — one timer period written to the TED's latch as 0 is the chip's full count, not an immediate fire.
- **Frequency `$3FE` is silence** — the top two frequency values hold the output at one level, which is how software gates a voice without touching the control register.
- **A write to a ROM bleeds through to the RAM under it** — which is how the KERNAL can load a program into a bank and run it there.
- **A C16's 16K mirrors four times** across the 64K map, so the KERNAL sees RAM everywhere the Plus/4 would have ROM.
- **`$FF3E`/`$FF3F` cannot be read**, and their unused bits read back as 1.
- **The TED's unused register bits read back as 1** (the chip's own table), which software uses to size memory.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| [`tests/plus4/plus4-machine.test.ts`](../../tests/plus4/plus4-machine.test.ts) | The 64K map and the C16's mirroring, the ROM banks and the write-through, the TED's unused bits and its raster counter, the raster compare interrupt, the timers, the text window's colours, the bad line's bounds, the keyboard matrix through PIO 2, the joystick gates, the 6529B's direction register, the ACIA's registers, exact snapshot restore; with the real ROMs, booting to BASIC 3.5's `READY.` with its `60671 BYTES FREE`, printing numbers and strings, drawing each character's eight glyph lines on its own raster line (so YSCROLL cannot rotate the picture), the `$FF19` border round the `$FF15` paper, and a picture register written mid-line repainting from its cycle | 2026-11-26 |
| [`tests/plus4/plus4-basic.test.ts`](../../tests/plus4/plus4-basic.test.ts) | BASIC 3.5's keyword table against the ROM's own entries, including the tokens past V2's `$CB`, the quoted-string and REM payload rules, and the variable tables | 2026-11-25 |
| [`tests/plus4/mc6551.test.ts`](../../tests/plus4/mc6551.test.ts) | The ACIA's frame timing on transmit and receive, the stop and parity bits in the frame, the transmit interrupt, and overrun | 2026-11-25 |
| [`tests/plus4/plus4-ocr.test.ts`](../../tests/plus4/plus4-ocr.test.ts) | The TEXT overlay's hires-bitmap matching (direct and inverse), non-glyph tiles, the multicolour bitmap being left alone, and multicolour text cells | 2026-11-25 |
| [`tests/plus4/plus4-media.test.ts`](../../tests/plus4/plus4-media.test.ts) | Cartridge parsing (plain and the three banked boards, and the Speedy refusal), the bank registers, media routing, the .tap platform and the TEXT overlay on the real ROM's banner | 2026-11-25 |
| [`tests/plus4/plus4-tape-format.test.ts`](../../tests/plus4/plus4-tape-format.test.ts) | The version-2 half-wave codec: the four-level 0/1 and word marker, the odd-parity bit, the 16-cycle entry unit and exact zero entry, the block starting level, and a SAVE export keeping both halves | 2026-11-26 |
| [`tests/plus4/plus4-tape-load.test.ts`](../../tests/plus4/plus4-tape-load.test.ts) | With the real ROMs: a dropped `.prg` LOADs to `FOUND`/`READY` and `LIST`s, and a KERNAL `SAVE` round-trips through `recordedBytes()` onto a fresh machine | 2026-11-26 |
| [`tests/plus4/plus4-expansion.test.ts`](../../tests/plus4/plus4-expansion.test.ts) | The Hannes 64K banks, the `$1000`/`$4000` switch bound and the TED's bank bit, and the CSORY 16K window (and that the TED does not see it) | 2026-11-25 |
| [`tests/machine-capabilities.test.ts`](../../tests/machine-capabilities.test.ts) | Every registered model's declared capability held against the service that has to honour it, including both Plus/4 models | 2026-11-22 |

Tests that need the Commodore ROMs read them from `mcp/.cache/plus4-dev` (the
copies from VICE) and skip when absent.
