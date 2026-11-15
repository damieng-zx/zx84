# Commodore 128

Commodore's 1985 successor to the 64: an 8502 that runs the 128's own BASIC 7.0 and can drop to 1 MHz C64 mode, a Z80 that exists only to bring the machine up and hand over at power-on, two video chips (the 40-column VIC-IIe and the 80-column 8563 VDC), and a serial bus built for the 1571's burst mode. zx84 emulates the MMU's two 64K blocks and page relocation, both video chips on one canvas, C64 mode through the real 64 ROMs, and a drive-level 1571 that speaks burst.

| | |
| --- | --- |
| **Manufacturer** | Commodore Business Machines |
| **Released** | 1985 (the 128D followed in 1986) |
| **CPU** | MOS 8502 (a 6502 with a 7-bit I/O port at `$00`/`$01`) at 0.985248 MHz (PAL) or 1.022727 MHz (NTSC), plus a Z80A that runs only until the BIOS hands over |
| **zx84 kind** | `c128` — [`src/machines/c128/`](../../src/machines/c128/) |
| **Model ids** | `c128` — the MCP `model` target and `?model=` value. The TV standard is the locale, as on the 64 and VIC-20: the model menu offers PAL and NTSC |
| **Accuracy** | Instruction-level CPU; the VIC-IIe is drawn lazily one cycle at a time and bad lines and sprite DMA hold the 8502 at instruction granularity. The VDC is drawn once a frame, from its registers at frame end. The Z80 takes T-states / 2 cycles of the master clock per instruction (the odd one carries on), with no wait states. In 2 MHz mode the 8502 takes two cycles to the master one except for the refresh cycles and I/O accesses, and the VIC-IIe reads the CPU's data bus instead of memory. No user-selectable accuracy setting |
| **Status** | New: boots the real ROMs to BASIC 7.0 on either screen, `GO64` and C= at power-on reach C64 mode, and a 1571 runs BASIC 7.0's disk commands over burst serial (see Verification) |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Commodore 128 PAL (`c128`) | 1985 | 128 KB in two 64K blocks + 2 × 1 KB colour RAM | 16 KB BASIC 7.0 low, 16 KB high, 16 KB system (screen editor, Z80 BIOS, KERNAL), 8 KB character, 8 KB 64 BASIC, 8 KB 64 KERNAL | 8566 VIC-IIe, 40 × 25 text, bitmap, multicolour, ECM, 8 sprites; 8563 VDC, 80 × 25 text and bitmap with attributes | 6581 SID, 3 voices | Datasette, a 1571 by default (or 1541 / 1581), up to four on the bus, 1351 mouse | 312 lines × 63 cycles, 985,248 Hz, 50.12 Hz. The VDC's frame is 704 × 248 pixels |
| Commodore 128 NTSC (`c128`, locale `us`) | 1985 | As PAL | The same ROMs: the KERNAL tells the two apart by counting raster lines | 8564 VIC-IIe: 263 lines × 65 cycles, 235 lines shown | 6581 SID at 1,022,727 Hz | As PAL | 59.83 Hz. Snapshots remember their standard and refuse the other |

### ROM sets

Each chip is a file of its own on the ROM host and has its own socket in the ROM pane, so any one can be replaced without the others. The six chips are of two sizes (16 KB and 8 KB), so a socket sits at its own offset in the six images end to end (72 KB) rather than at a multiple of one stride; the whole 72 KB dropped on any socket fills every socket.

| Socket | File | Size | Notes |
| --- | --- | --- | --- |
| BASIC low | `c128/basiclo-318018-04.rom` | 16 KB | BASIC 7.0 at `$4000`–`$7FFF` |
| BASIC high | `c128/basichi-318019-04.rom` | 16 KB | BASIC 7.0 at `$8000`–`$BFFF` |
| System ROM | `c128/kernal-318020-05.rom` | 16 KB | `$C000`–`$FFFF` as the 8502 sees it: the screen editor's jump table at `$C000`, the KERNAL at `$E000`, and the Z80 BIOS in the 4K under the I/O page (`$1000`–`$1FFF`), which the Z80 sees at its `$0000`–`$0FFF` |
| Character ROM | `c128/chargen-325078-03.rom` | 8 KB | Two 4K half-sets: the 64's first (C64 mode uses it), the 128's own second. The VIC-IIe fetches the 128's set in C128 mode; the KERNAL copies one into VDC RAM for the 80-column screen |
| 64 BASIC | `c64/basic-901226-01.rom` | 8 KB | C64 mode's BASIC V2 at `$A000`. Shared with the C64, same cache |
| 64 KERNAL | `c64/kernal-901227-03.rom` | 8 KB | C64 mode's KERNAL at `$E000`. Shared with the C64 |
| 1541 / 1571 / 1581 DOS | The 64's files (`c64/dos…`) | 16 / 32 / 32 KB | Shared with the C64 and VIC-20, same cache. A socket only while that drive is fitted |

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| MOS 8502 CPU | all | ✅ | [`src/cores/m6502.ts`](../../src/cores/m6502.ts) plus the 7-bit I/O port and the MMU in [`memory.ts`](../../src/machines/c128/memory.ts) and [`mmu.ts`](../../src/machines/c128/mmu.ts). **2 MHz mode** (`$D030` bit 0, in C64 mode too): the 8502 runs at two cycles to the 1 MHz master cycle, except for the five refresh cycles of every line (a fast PAL line is 121 CPU cycles) and every access to the I/O page, which ends on a 1 MHz edge (`INC $D020` takes 8 cycles to `INC $C000`'s 6). See [`fast-clock.ts`](../../src/machines/c128/fast-clock.ts) |
| Z80A | all | ✅ | [`src/cores/z80.ts`](../../src/cores/z80.ts). It starts at reset and runs until the BIOS sets the mode register's bit 0 and starts the 8502 (as if reset, the first time); after that the two CPUs hand the bus to each other through that bit and each resumes where it stopped, which is how CP/M's Z80 code gets its disk handler run on the 8502. Its 4K BIOS is visible at `$0000` whenever the RAM block is 0, and its `IN`/`OUT` reach `$D000`–`$DFFF` whatever the configuration register's bit 0 says (an I/O cycle is not a memory one). Each instruction takes T-states / 2 master cycles with the odd T-state carried to the next (LDIR is 10.5 cycles a byte, as measured on a real machine), with no wait states and no DMA; the VIC-IIe's bus holds apply to it as to the 8502. It has no NMI. The debugger and trace follow whichever CPU is running |
| MMU 8722 | all | ◐ | [`mmu.ts`](../../src/machines/c128/mmu.ts). Twelve registers at `$D500`–`$D50B` (the configuration register also at `$FF00`, and `$FF01`–`$FF04` write = load PCR A–D into it), two 64K RAM blocks, pre-configuration registers for the Z80 and the 8502, page 0/1 relocation with its high-byte latches (pages 0 and 1 are block 0's until a pointer moves them; the stack wins over page 0 when both name a page; in C64 mode a pointer set before the switch still swaps its target page back, and the registers are hidden at `$D5xx`), common RAM at the bottom (1K/4K/8K/16K) and top (1K/4K/8K/16K) of the block, the VIC-IIe's own block, the mode register's CPU and C64-mode bits, and the fast serial direction. The two-block (128K) machine only: `CR` bit 7 and `RCR` bit 7 are ignored |
| VIC-IIe 8566 / 8564 | all | ◐ | [`src/cores/vic-ii.ts`](../../src/cores/vic-ii.ts), the C64's core. Standard and multicolour text and bitmap, extended-colour text, sprites, border windows, scrolling, raster IRQ, bad-line holds. `$D02F` selects the three extra keyboard lines and `$D030` bit 0 is the 2 MHz mode, both in C64 mode too (the register is the chip's, which the MMU does not hide). In 2 MHz mode the chip runs on (raster, bad lines, borders, interrupts) but never holds the CPU, and its c- and g-accesses read the CPU's data bus: the colour and screen byte of a two-cycle instruction's opcode, the pixels of its operand. The real-hardware 2mhzVIC pictures come out pixel for pixel. Sprites still read memory. BASIC's `FAST` blanks the screen through DEN. Light pen is not wired |
| VDC 8563 | all | ◐ | [`vdc.ts`](../../src/machines/c128/vdc.ts) and [`vdc-display.ts`](../../src/machines/c128/vdc-display.ts). `$D600` selects a register (a read gives the status: ready, vertical blanking, version) and `$D601` reads or writes it; registers 18/19 are the update address and 31 the data port, which auto-increments. Text and bitmap modes, the attribute byte (alternate set, reverse, underline, flash, 4-bit RGBI foreground), cursor modes, both smooth scrolls (R25 raises the picture rightwards from its unscrolled value: `R22 >> 4` on the 8563 R8/R9 and the 8568, 0 on the early R7A), double-pixel mode (the "40 columns"), the display stop and line count the registers say, 16K or 64K of RAM with the real chip's address scrambling when the mode does not match the chip, block copy and fill. The chip revision (8563 R7A, 8563 R8/R9, 8568) is chosen in the Hardware pane and is what the status register reports. **Interlace (R8), the display-enable window (R34/R35) and the light pen are not modelled**, and a block operation finishes at once and always reads ready |
| SID 6581 | all | ◐ | [`src/cores/mos6581.ts`](../../src/cores/mos6581.ts), shared with the 64. The Sound pane's **SID** menu picks the 6581 or the 8580 live; the `c64-sid` setting is shared with the 64. See the [C64 sheet](commodore-64.md) for what each chip models |
| CIA 6526 × 2 | all | ✅ | [`src/cores/mos6526.ts`](../../src/cores/mos6526.ts). CIA 1: keyboard matrix and rows, both joystick ports, the Datasette, IRQ, and the **fast serial shift register** that burst mode runs on. CIA 2: VIC-IIe bank, the serial bus (ATN/CLK/DATA out on port A bits 3-5), NMI. Colour RAM bank selection is the 8502 port's, not the CIAs' |
| Keyboard | all | ✅ | [`keyboard.ts`](../../src/machines/c128/keyboard.ts). The 64's 8 × 8 matrix through CIA 1, plus three lines (K0-K2, chosen by `$D02F` bits 0-2) carrying HELP, TAB, ESC, ALT, LINE FEED, NO SCROLL, the cursor keys and the keypad. CAPS LOCK is read from the 8502 port's bit 6 and the 40/80 DISPLAY key from the MMU's mode register bit 7; both latch. RESTORE is an NMI, as on the 64. Host keys: F9 = ESC, F10 = HELP, right Alt = ALT, Scroll Lock = NO SCROLL, Page Down = LINE FEED, Caps Lock and Pause latch CAPS LOCK and 40/80. In 128 mode the arrows, Tab and the numeric keypad (KP ENTER too) press their own cells of the extra lines; in 64 mode the 64's mapping stays (cursors with SHIFT, Tab as CTRL). The Keyboard pane is the breadbin caps with a strip of the extra keys below them, which do nothing in C64 mode because its matrix does not scan them |
| Datasette | all | ✅ | See Peripherals |
| Joystick ports | all | ✅ | Two control ports on CIA 1; each player picks the port its stick is in, as on the 64 |
| User port, RS-232, expansion port | all | ✗ | See Not emulated |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Datasette (tape) | Tape | all | ✅ | Edge-timed through the 8502 port's cassette lines. A mounted tape has PLAY down; the motor (port bit 5) moves it. An empty deck counts as RECORD + PLAY, so `SAVE` just works and the result can be downloaded as a C64 `.tap`. Turbo loading follows the Cassette port's reads and write-line activity. Dropping a `.prg` or `.t64` also mounts a generated KERNAL-format tape of it |
| Commodore 1571 | Disk | all | ✅ | **The 128's own drive, and the default.** Drive-level, not a KERNAL trap: a 6502 at 1 or 2 MHz with the real 32 KB DOS ROM, the two 6522s of a 1541 plus a 6526 CIA and a WD1770. **Burst mode works**: BASIC 7.0's `DIRECTORY`, `DLOAD`, `DSAVE`, `COPY` and `HEADER` send their commands and take their data through CIA 1's shift register, the MMU's mode register giving the direction, with the DOS entering its 2 MHz double-sided mode. Reads `.d71`, and the 1541's `.d64` and `.g64`. The MFM side of its WD1770 has no disk to put in it |
| Commodore 1541 | Disk | all | ✅ | The 64's drive at 1 MHz. **No burst**: the 128's KERNAL probes for it, gets no answer and falls back to the ordinary serial bus, as on the real pairing. Reads `.d64` and `.g64` |
| Commodore 1581 | Disk | all | ✅ | The 64's 3.5" drive (a 6526 and a WD1770 at `$6000`), with burst mode so BASIC 7.0's disk commands run fast on it too. Reads `.d81` |
| Up to four drives | Disk | all | ✅ | Devices 8 to 11, each a 1541, 1571 or 1581 (any mix), chosen in the Drives pane. A 1571 is fitted by default. The **Disk drive** checkbox in the Hardware pane plugs all of them in or out, and a change rebuilds the machine |
| 1351 mouse | Input | all | ✅ | Mouse pane, in control port 1 or 2, through the SID's POT lines as on the 64 |
| Joystick | Input | all | ✅ | Control port 1 or 2 per player (Joystick pane) |
| Cartridges and function ROMs | Expansion port | ◐ | 64 cartridges (`.crt`) in C64 mode on the 64's boards, and 128 function ROMs (bare 8K/16K/32K or `C128 CARTRIDGE` `.crt`) over `$8000`-`$FFFF` through the MMU, autostarted by the KERNAL's CBM header scan. Short images are mirrored. Boards: generic, Warpspeed128, Partner 128 (RAM window and ROM mirror; not its VDC snoop or freeze logic), Comal 80 (six banks on ROMH), Magic Desk 128 (the register is the whole of `$DE00`-`$DEFF`; a read does not latch). **Gmod2-C128 is refused.** The internal function ROM socket has no media slot |

**Combination rules:** none; the drive is optional and independent of the tape.

---

## Media formats

ZIP archives are unpacked; the first loadable entry is mounted, with a picker when there are several.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.tap` | Tape | Datasette | ✅ | ✅ | C64 TAP (pulse lengths in 8-cycle units, v0 and v1), which the 128's KERNAL reads. Save downloads what the KERNAL has SAVEd, as a C64 `.tap`. A `.tap` that is not a C64 tape is refused, since the Spectrum's format shares the extension |
| `.t64` | Program | Datasette | ✅ | — | The first program is put in memory and RUN (VICE-style autostart); a generated tape is mounted as well |
| `.prg` | Program | Datasette | ✅ | — | As `.t64`. **A BASIC program says its mode by where it starts**: BASIC 7.0's at `$1C01` stays in C128 mode, the 64's at `$0801` restarts the machine in C64 mode with C= held through the BIOS's read, as a person would |
| `.d64` | Disk | A 1541 or 1571 | ✅ | ✅ | 35, 40 or 42 tracks; saved as `.d64` while every sector can still be read, otherwise as `.g64` |
| `.g64` | Disk | A 1541 or 1571 | ✅ | ✅ | `GCR-1541` v0. Odd-length tracks, half tracks and custom speeds survive |
| `.g41` | Disk | A 1541 or 1571 | ✅ | ✅ | A G64 under another name (the `GCR-1541` format), read and saved as one |
| `.d71` | Disk | A 1571 | ✅ | ✅ | 349,696 bytes: a `.d64` for each side, the second side's tracks numbered 36-70 on the same 35 cylinders |
| `.d81` | Disk | A 1581 | ✅ | ✅ | 819,200 bytes of 256-byte sectors, a pair to each 512-byte sector |
| `.c128state` | Snapshot | Machine | ✅ | ✅ | zx84's own exact save state: the 8502 and the Z80, the machine's frame position, the TV standard, both 64K RAM blocks with their colour RAM and the 8502 port, the MMU, the VDC's registers and RAM, the VIC-IIe, the SID, both CIAs, the fast serial shift registers and the drives. A state saved with the other amount of VDC RAM is refused with a message |

**Save menu exports:** snapshot (`.c128state`), tape (`.tap`), screenshot (PNG), RAM (`.bin`).

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Two video chips, one canvas | ✅ | The Display menu in the Hardware pane chooses **Auto** (follows the 40/80 DISPLAY key, and shows the VIC-IIe in C64 mode), **40 columns** or **80 columns**. The frame size, the pixel buffer and the pixel shape follow the chip shown, so the 80-column frame (704 × 248) gets its own aspect ratio. The editor reads the key at reset, so changing it afterwards does not move a running editor to the other chip |
| C64 mode | ✅ | `GO64` (answer `Y`) switches on the fly, and holding C= through the power-on BIOS starts there. The map is the 64's PLA, steered by the 8502 port's LORAM, HIRAM and CHAREN: 64K of RAM, the 64's BASIC and KERNAL, the character ROM's first 4K, and `$FF00`–`$FF04` as plain memory. The VIC-IIe's `$D02F`/`$D030` stay (a 64 program can run 2 MHz as on the real machine) and the MMU is hidden. Snapshots carry it |
| Tape auto-PLAY and turbo | ✅ | PLAY is pressed for you when the KERNAL polls the tape port; load time shrinks with the turbo setting |
| Disk turbo | ✅ | Runs flat out while a drive's motor is on and its controller is moving bytes or the serial bus is carrying a file |
| VDC RAM 16K / 64K | ✅ | The 128 has 16K; the 128D and later boards 64K. Chosen in the Hardware pane, which rebuilds the machine |
| VDC chip | ✅ | The early 8563 R7A, the 8563 R8/R9 (default, the flat 128 and 128D) or the 8568 (128DCR). The KERNAL editor reads the version from the status register and sets the smooth-scroll register to match |
| Border size | ✅ | Normal, small, none (the 80-column frame is shown whole) |
| Colour map | — | The VIC-IIe's sixteen colours and the VDC's RGBI ones are fixed |
| Programs in the Library | ✗ | No library for the 128 |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | The 6502 family service with the 64K the 8502 sees (ROM and I/O as banked), and the Z80's own while it runs (registers, disassembly and a trace over both CPUs) |
| Trace | ✅ | Full and port-I/O modes, of whichever CPU is running |
| Beam debugging | ✅ | `beam_log`, `interrupt_log` and `run` with `until_line`: 312 lines × 63 cycles per frame |
| Screen OCR / TEXT overlay | ✅ | Both screens. The 40-column screen is read from the VIC-IIe's video matrix as on the 64, matching glyphs against the 128's own 4K set (the 64's in C64 mode). The 80-column screen is read from VDC RAM against the font the KERNAL copied there, with the cell size its registers give rather than an assumed 8 × 8, and the attribute bits (alternate set, reverse, inverse glyphs). A glyph is matched by its shape against the character ROM's 128 set, so CP/M's font (lower case at the ASCII codes) reads as well as the KERNAL's. Bitmap modes read as nothing |
| BASIC Listing / Variables panes | ✗ | BASIC 7.0's token table and variable layout are not written yet, so both panes sit at "(no BASIC program)" in every mode. The 64's BASIC V2 parser does not apply to BASIC 7.0 |
| Machine-specific panes | ✅ | Memory map (the MMU's map, RAM block, common RAM, page relocation, the VIC-IIe bank, the display chip), Memory regions (all six ROMs, colour RAM, VDC RAM), Tape, Drives, Joystick, Mouse, ROM / Carts, Keyboard, Hardware. Microdrive, system-variable and font panes are hidden |
| MCP tools | ✅ | The generic tools (`registers`, `step`, `disassemble`, `memory`, `trace`, `beam_log`, `ocr`, `screenshot`, `type`, `key`, `load`, `eject`) plus `chip_state` (`vic`, `vdc`, `sid`, `cia1`, `cia2`, `mmu`, `drive` with a drive fitted) and the shared Commodore tools: `c64sid` and `c64drive` work on a 128, `load` takes `.d71`/`.d81`/`.c128state`, and `type` enters the character the key makes, as on the 64 |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| 2 MHz details not settled | 8502, VIC-IIe | low | The five refresh cycles are placed from line cycle 9 and the VIC-IIe samples the bus a half cycle apart for c- and g-accesses because the real-hardware test pictures come out that way here, not from a measurement of the chip. Sprites read memory rather than the bus, whether `$FF00`-`$FF04` are stretched is unknown, and the test bit (`$D030` bit 1) does nothing |
| No real-time check in a browser | All | low | Verified headlessly and by tests. **Neither screen has been watched in a browser**, because the ROMs were not hosted while this was built; the frames were checked as PNGs written from the headless machine |
| The 40/80 key is read at reset only | Display | low | As on the real machine's editor: pressing 40/80 after boot switches what the canvas shows, but the editor stays on the chip it chose. A program-driven switch is ESC-X or a reset |
| Block copy and fill are instant | VDC | low | A block operation finishes at once and always reads ready, so software that times it sees no delay (a real 128 shows `vdc4`'s write dropped; ours puts the character up) |
| CP/M on a 1571 disk needs MFM | CP/M | medium | CP/M 3.0 boots and runs from a **1581** `.d81` (the VICE project's `cpm3.d81`: the prompt, `DIR`, `TYPE`, `PIP` writing a file, `DEVICE CONOUT:=80COL`). A 1571's MFM CP/M disks are not readable: the 1571's WD1770 has no MFM disk model. CP/M's own tests (`zexdoc`, `zexall`) have not been run. |
| Idle drives cost emulation speed | 1541, 1571, 1581 | low | Each drive's 6502 and chips run in lock-step with the 128, as on the 64 |

## Not emulated

- **Gmod2-C128** (512K flash and an EEPROM), the Partner 128's VDC snoop and freeze logic, and a media slot for the internal function ROM socket.
- **VDC interlace**, the display-enable window (R34/R35), the light pen, and a block operation's timing.
- The Z80's DMA and bus holds by bad lines, and the 1571's MFM mode (so CP/M disks in 1571 format).
- **BASIC 7.0's detokenised listing and variables**: the panes are shown but stay empty, because the 128 has no parser of its own yet and BASIC 7.0's tokens are not BASIC V2's.
- The 6567R56A and other NTSC VIC-II revisions, and the 128DCR's other differences (6526A, 8580, the combined KERNAL).
- User port, RS-232, printer, the 1902/1084 monitor details, paddles and other analogue devices beyond the 1351 mouse, and REU/GeoRAM.
- Other drives: the 1541-II, 1570 and 1571CR, the IEEE-488 drives and third-party ones; `.x64`/`.g71`, and device numbers changed in software.

## Faithful quirks

- **The Z80 only runs until the BIOS hands over** — at reset the Z80 is in charge and the 8502 is held; the BIOS sets the mode register's bit 0 and the 8502 starts as if it had been reset, reading its vector from whatever the map shows. The 8502's cycle counter is the master clock throughout.
- **A BASIC program's load address picks the mode** — `$1C01` is BASIC 7.0's and `$0801` is BASIC V2's, so a dropped `.prg` starts the machine in the mode its program is for. That is what a person does, not a special case.
- **The 128's power-on screen is not the 64's** — light green on dark grey, where a 64 is light blue on blue.
- **The 40/80 key is latched and read at reset** — pressing it later changes what the canvas shows but not what a running editor draws, so an 80-column program is started with ESC-X or a reset.
- **A 1571 is a 1541 until a 128 tells it otherwise** — the DOS enters its double-sided burst mode only when the 128 sends the command; a 64 sees one side of a `.d71`.
- **The character ROM is two half-sets** — the 64's 4K first, the 128's own second, and the VIC-IIe fetches the 128's in C128 mode. The KERNAL copies the set into VDC RAM for the 80-column screen, so the VDC has no character ROM of its own.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| [`tests/c128/mmu.test.ts`](../../tests/c128/mmu.test.ts) | The twelve registers, the configuration register's ROM/RAM bits, both common-RAM regions, the pre-configurations, page 0/1 relocation, the mode register's CPU and C64 bits | 2026-11-12 |
| [`tests/c128/memory.test.ts`](../../tests/c128/memory.test.ts) | The 128 map and the C64 PLA for all eight port values, writes under ROM, the RAM block, `$FF00`, no relocation in 64 mode, colour RAM banks, the VIC's character-ROM rule, the Z80's 4K BIOS and `IN`/`OUT` window | 2026-11-12 |
| [`tests/c128/c128-machine.test.ts`](../../tests/c128/c128-machine.test.ts) | The Z80 starting the machine and handing over, the keyboard's three extra lines through CIA 1, and with the real ROMs: booting to the BASIC 7.0 banner and READY on both screens, typing, moving a byte between the blocks with `BANK`, `GO64` and C= at power-on reaching C64 mode, the display selection (including Auto showing the VIC-II in C64 mode) | 2026-11-12 |
| [`tests/c128/vdc.test.ts`](../../tests/c128/vdc.test.ts) | The ports, the register file, the update address and its auto-increment, fill, copy including an overlapping source and destination, the status register | 2026-11-12 |
| [`tests/c128/vdc-display.test.ts`](../../tests/c128/vdc-display.test.ts) | Every drawn feature of the 80-column screen with hand-computed pixels: cell geometry, text and bitmap modes, both character sets, the attribute bits, monochrome and attribute colours, reverse, underline, flash, the cursor, the row increment, semigraphics, both smooth scrolls | 2026-11-12 |
| [`tests/c128/c128-drives.test.ts`](../../tests/c128/c128-drives.test.ts) | **With the real DOS ROMs**, BASIC 7.0 on a 1571: `DIRECTORY`, `DLOAD` + `RUN`, `DSAVE`, `COPY` and `HEADER` over the burst bus (hundreds of CNT edges a directory), and `DIRECTORY`/`DSAVE` on a 1581; `DIRECTORY` and `DLOAD` on a 1541 falling back to the slow bus; `LOAD "$",8` from C64 mode with the 1571 acting as a 1541 | 2026-11-12 |
| [`tests/c128/c128-services.test.ts`](../../tests/c128/c128-services.test.ts) | The descriptor and services, the six ROM sockets and their two sizes, `.prg`/`.t64` injection picking the mode from the start address, the Datasette (auto-PLAY, `LOAD "B"`, `SAVE` recording pulses), `.c128state` save and restore, the memory regions, the TEXT overlay on both screens | 2026-11-15 |
| [`tests/c128/c128-ocr.test.ts`](../../tests/c128/c128-ocr.test.ts) | The VDC grid's geometry from its registers (origin, cell and row pitch, the shown part, both scrolls), the attribute bits, alternate and inverse glyphs, both fields and blanking rectangles, the transcribe driver and its LED | 2026-11-15 |
| [`tests/c128/mmu-pages.test.ts`](../../tests/c128/mmu-pages.test.ts) | Page 0 and 1 and the pointers, as the real-hardware `c64modemmu` and `mmuswap` programs of the VICE project show them (all 40 pass on the real ones): block 0 whatever CR says, the swap back, the stack winning, the common RAM arms, the Z80 having no port, C64 mode keeping the swap back but not the forward move | 2026-11-15 |
| [`tests/c128/c128-fast.test.ts`](../../tests/c128/c128-fast.test.ts) | 2 MHz: the 121-cycle fast line, the 8-cycle `INC $D020`, 64 mode, no bad-line stalls, the VIC-IIe drawing the CPU bus (c-access colour and g-access pixels, latched colours below a bad line, `$FF` where undriven), snapshots, and with the ROMs BASIC's `FAST` and `SLOW`. The real-hardware 2mhzVIC pictures (hires, multicolour, extended colour) were checked pixel for pixel against the reference screenshots while building it | 2026-11-15 |
| [`tests/c128/c128-handover.test.ts`](../../tests/c128/c128-handover.test.ts) | The 8502 resumes where it stopped when the Z80 hands the bus back (CP/M's Z80 loader calls an 8502 disk handler this way); only the first start out of power-on resets it | 2026-11-15 |
| [`tests/c128/c128-cpm.test.ts`](../../tests/c128/c128-cpm.test.ts) | With the real ROMs, DOS and `cpm3.d81`: CP/M 3.0 boots to `A>` and `DIR` lists the disk (skipped without the image in `mcp/.cache/c128-dev`) | 2026-11-15 |
| [`tests/c128/c128-z80-timing.test.ts`](../../tests/c128/c128-z80-timing.test.ts) | T-states / 2 with the odd one carried (LDIR 10.5 cycles a byte), and no NMI to the Z80 | 2026-11-15 |
| [`tests/c128/vdc-revisions.test.ts`](../../tests/c128/vdc-revisions.test.ts) | The scroll by chip version, double-pixel mode, the display stop and line count, the RAM address maps, light pen registers, unused bits and the copy-then-fill byte | 2026-11-15 |
| [`tests/c128/c128-cartridge.test.ts`](../../tests/c128/c128-cartridge.test.ts) | 64 cartridges in C64 mode and every 128 function-ROM board: mirroring, Magic Desk masks and file order, Partner, Warpspeed, Comal 80, the refused boards, snapshots, autostart with the real ROMs | 2026-11-15 |
| [`tests/c64/fast-serial-bus.test.ts`](../../tests/c64/fast-serial-bus.test.ts) | The shared CIA shift register and fast serial bus, which burst mode depends on | 2026-11-12 |

Tests that need the Commodore ROMs read them from `mcp/.cache` (the copies from VICE) and skip when absent. The line and frame counts are the VIC-IIe's; the VDC's frame is drawn once a frame rather than at a measured beam rate.
