# Commodore 64

Commodore's 1982 6510-based home computer, the best-selling single computer model of all time. zx84 emulates the PAL machine and the NTSC one with a cycle-stolen VIC-II, the 6581 SID, both CIAs, the Datasette, a drive-level 1541, 1571 or 1581 disk drive that runs the real DOS ROM, cartridges and the 1351 mouse.

| | |
| --- | --- |
| **Manufacturer** | Commodore Business Machines |
| **Released** | 1982 |
| **CPU** | MOS 6510 (a 6502 with an I/O port at `$00`/`$01`) — 0.985248 MHz (PAL) or 1.022727 MHz (NTSC) |
| **zx84 kind** | `c64` — [`src/machines/c64/`](../../src/machines/c64/) |
| **Model ids** | `c64` — the MCP `model` target and `?model=` value. The TV standard is the locale, as on the Atari: the model menu offers PAL and NTSC, and the MCP `model` tool takes `tv` |
| **Accuracy** | Instruction-level CPU; the VIC-II is drawn lazily one cycle at a time, and bad-line and sprite DMA hold the CPU at instruction granularity (an instruction overtaken part-way is stretched). CIA timers are advanced arithmetically; register accesses land on their own cycle. No user-selectable accuracy setting |
| **Status** | Working — boots the real ROMs to BASIC, loads tapes and disks; see Verification |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Commodore 64 PAL (`c64`) | 1982 | 64 KB + 1 KB colour RAM | 8 KB BASIC V2, 8 KB KERNAL, 4 KB character ROM | 6569 VIC-II, 40 × 25 text, bitmap, multicolour, ECM, 8 sprites | 6581 SID, 3 voices | Datasette, 1541 or 1581 disk drive (device 8), cartridge, 1351 mouse | 312 lines × 63 cycles, 985,248 Hz, 50.12 Hz |
| Commodore 64 NTSC (`c64`, locale `us`) | 1982 | As PAL | The same ROMs: the KERNAL tells the two apart by counting raster lines | 6567R8 VIC-II: 263 lines × 65 cycles, 235 lines shown | 6581 SID at 1,022,727 Hz | As PAL | 59.83 Hz. Snapshots remember their standard and refuse the other |

### ROM sets

Each ROM is a file of its own on the ROM host and has its own socket in the ROM pane, so any one can be replaced without the others. A 20 KB whole image (BASIC + KERNAL + character ROM end to end) dropped on any socket fills all three.

| Socket | File | Size | Notes |
| --- | --- | --- | --- |
| BASIC | `c64/basic-901226-01.rom` | 8 KB | `$A000`–`$BFFF` |
| KERNAL | `c64/kernal-901227-03.rom` | 8 KB | `$E000`–`$FFFF` |
| Character ROM | `c64/chargen-901225-01.rom` | 4 KB | Seen by the VIC-II at `$1000`/`$9000`, and by the CPU at `$D000` when banked in |
| 1541 DOS | `c64/dos1541-325302-01-901229-05.rom` | 16 KB | 325302-01 at `$C000`, 901229-05 at `$E000`. A socket only while a 1541 is fitted |
| 1571 DOS | `c64/dos1571-310654-05.rom` | 32 KB | `$8000`-`$FFFF` of the drive. A socket only while a 1571 is fitted |
| 1581 DOS | `c64/dos1581-318045-02.rom` | 32 KB | `$8000`-`$FFFF` of the drive. A socket only while a 1581 is fitted |

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| MOS 6510 CPU | all | ✅ | [`src/cores/m6502.ts`](../../src/cores/m6502.ts) plus the I/O port and PLA banking in [`memory.ts`](../../src/machines/c64/memory.ts). The read-modify-write dummy write reaches I/O (an `INC $D019` acknowledges the VIC-II) |
| VIC-II 6569 / 6567R8 | all | ◐ | [`vic-ii.ts`](../../src/machines/c64/vic-ii.ts), after Christian Bauer's *The MOS 6567/6569 video controller (VIC-II)*. Standard and multicolour text and bitmap, extended-colour text, sprites (expansion, multicolour, priority, collisions), border flip-flops and the 38/24-line windows, scrolling, raster IRQ. Bad lines hold the CPU for 43 cycles, sprite DMA steals its slots. The NTSC chip has two more cycles a line; they are placed after the sprite-DMA check, so its sprite fetches and row-counter update fall two cycles later in the line (derived from the line length, not measured against hardware). Light pen is not wired |
| SID 6581 | all | ◐ | [`src/cores/mos6581.ts`](../../src/cores/mos6581.ts). Three voices with all four waveforms, ADSR with the rate counter's quirks, sync and ring modulation, the state-variable filter modelled on the 6581's measured cutoff curve. POTX/POTY read full scale (nothing connected) unless a 1351 mouse is in. The Sound pane's **SID** menu chooses the chip live: the original **6581** or the C64C's **8580**. The 8580 has no DC level (so playing samples through the volume register alone is silent on it, as on the real chip), a cutoff curve that is close to a straight line up to 12.5 kHz (after reSID's curve), a gentler resonance (1/Q from 1.41 to 0.59) and no saturation or input-dependent cutoff; voices, envelopes, noise and the ANDed combined waveforms are the same on both, where the real chips' combined waveforms differ |
| CIA 6526 × 2 | all | ✅ | [`src/cores/mos6526.ts`](../../src/cores/mos6526.ts). Both timers (continuous, one-shot, PB6/PB7 output, timer B counting timer A), interrupt control, BCD time of day with alarm, serial register. CIA 1: keyboard matrix, joysticks, cassette FLAG, IRQ. CIA 2: VIC bank, serial bus, NMI |
| Keyboard | all | ✅ | 8 × 8 matrix scanned through CIA 1 from the host keyboard. RESTORE is not in the matrix: it pulls NMI (host key `PageUp`). The Keyboard pane is an on-screen breadbin keyboard of 66 dark caps (the 64 matrix keys, RESTORE and SHIFT LOCK) laid out from a photograph of the real thing: rows staggered like a typewriter's, RESTORE and RETURN wide, grey function keys two keys wide and level with the first four rows, caps touching, an SVG Commodore logo on the C= key, a pair of arrows on each cursor key, the space bar under the letters, and SHIFT legends above the main ones: click and hold to press, SHIFT / CTRL / C= latch for one keystroke so one pointer can chord, SHIFT LOCK latches until clicked again, and caps light for host keystrokes too. The graphics symbols and colour names printed on the fronts of the real caps are not drawn |
| Datasette | all | ✅ | See Peripherals |
| Joystick ports | all | ✅ | Two ports on CIA 1; each player picks the port its stick is in. Player 1 starts in port 1, player 2 in port 2 |
| User port, RS-232, expansion port | all | ✗ | See Not emulated |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Datasette (tape) | Tape | all | ✅ | Edge-timed through CIA 1's FLAG input. A mounted tape has PLAY down; the motor (port bit 5) moves it. An empty deck counts as RECORD + PLAY, so `SAVE` just works and the result can be downloaded. Turbo loading follows CIA 1 ICR reads and write-line activity. Dropping a `.prg` or `.t64` also mounts a generated KERNAL-format tape of it, so the Tape pane shows its name and blocks and `LOAD` finds it |
| Commodore 1541 | Disk | all | ✅ | **Drive-level, not a KERNAL trap.** The drive is its own 6502 at 1 MHz with 2 KB RAM, the DOS ROM and two 6522 VIAs (VIA 1 the serial bus, VIA 2 the disk controller), turning a GCR track under the head at the real speed-zone bit rates, stepper and motor included. It is connected to the 64 through a modelled IEC bus (open-collector CLK/DATA/ATN) and brought up to the 64's clock at every `$DD00` access and at frame end. Fitted by default; the Hardware pane's **1541 disk drive** checkbox removes it (and the ROM pane's 1541 DOS socket with it). One drive, device 8 |
| Commodore 1581 | Disk | all | ✅ | **Drive-level too.** A 6502 at 2 MHz with 8 KB RAM, the 32 KB DOS ROM, a 6526 CIA (the serial bus and the control port: side, motor, LED, device number, disk change, write protect) and a WD1770 floppy controller at `$6000`, driving 3.5" double-density disks: 80 cylinders, two sides, ten 512-byte sectors, 800 KB. The controller is the shared sector-level WD177x model (the disk is the shared `DskImage`, as the +D's and the Einstein's are), so a transfer runs as fast as the DOS polls it. The DOS runs unmodified: `LOAD"$",8`, `LOAD`, `SAVE`, `N:` (a WRITE TRACK per track) and disk changes all work. The drive's model is picked in the Drives pane's "..." menu, as the Atari's are. **Up to four drives share the bus, as devices 8 to 11**, each a 1541 or a 1581 (any mix): **Add drive** puts a new empty one below, **Remove drive** takes one out with its disk, **Model** swaps one. The drives below a change move to the next device number (and start over, as the DOS reads its device jumpers at power-on), and write protect stays with the place. A drive of a model already fitted copies that drive's DOS ROM and appears at once; the first drive of a model not yet fitted rebuilds the machine to fetch its ROM. The drives share the DOS ROM of their model (one ROM-pane socket each), pull the bus lines together, and are brought up to the 64's clock one after the other. Dropping or loading a `.d81` (or a zip of one) when no drive reads it sets the first empty drive, else drive 8, to a 1581 and mounts the disk, rebuilding the machine to fetch the ROM the first time; a `.d64` does the same for a 1541. The **Disk drive** checkbox in the Hardware pane plugs all of them in or out |
| Commodore 1571 | Disk | all | ✅ | **A 1541 with a second head, a 2 MHz mode and a few chips for the C128**, built on the 1541's drive: the same two VIAs and GCR electronics, with the second side's 35 tracks on the same cylinders (VIA 1 port A bit 2 picks the head), a 32 KB DOS ROM at `$8000`, a 6526 CIA at `$4000` (the C128's fast serial bus; nothing on the 64 drives it) and a WD1770 at `$2000` (MFM, for CP/M; there is no MFM disk to put in it). Port A bit 5 switches the 6502 to 2 MHz while the disk keeps turning at the same speed, so the drive's time is counted in ticks of 2 MHz and a bit cell takes twice as many cycles; bit 0 reads the track-0 sensor and bit 7 the byte-ready latch (cleared by any access to VIA 2's ports, as the DOS's write loop expects). **To a 64 it is a 1541 until told otherwise**, as on the real drive (the DOS enters its 2 MHz double-sided mode when a C128 sends a burst command): a `.d71` shows 664 blocks free and only its first side until `OPEN15,8,15,"U0>M1":CLOSE15`, and `U0>M0` goes back. Chosen in the Drives pane's "..." menu like the others; reads `.d71`, and the 1541's `.d64` and `.g64` as a 1541 would |
| Cartridges | Expansion port | all | ✅ | `.crt` files in the ROM pane's Cartridge slot or dropped on the machine. Fitting or ejecting one is a power cycle. EXROM and GAME drive the PLA: 8K (ROML at `$8000`), 16K (ROMH over BASIC at `$A000`) and Ultimax (ROML and ROMH at `$E000`, no RAM above `$1000`, boots from the cartridge's own reset vector). Boards: normal, Simons' BASIC, Ocean type 1, Fun Play / Power Play, Super Games, Epyx FastLoad (the capacitor, timed in CPU cycles), System 3, Dinamic, Zaxxon, Magic Desk and EasyFlash (read only). Other hardware types are refused with their number. Not remembered across a browser reload; snapshots carry the cartridge |
| 1351 mouse | Input | all | ✅ | Mouse pane, in control port 1 or 2. Position through the SID's POTX/POTY (6-bit counters in bits 1-6, up counting up, read on the port CIA 1 port A bits 6-7 select); the left button is the port's fire line and the right button reads as up. Motion is cut to ±31 a report so a driver can tell the direction of a flick |
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
| `.d64` | Disk | A 1541 (device 8-11) | ✅ | ✅ | 35, 40 or 42 tracks, with or without the trailing error bytes (kept, and read back as the matching disk errors). Saved as `.d64` when every sector can still be read from the GCR, otherwise as `.g64` |
| `.g64` | Disk | A 1541 (device 8-11) | ✅ | ✅ | `GCR-1541` v0: per-half-track bit streams and speed zones. Odd-length tracks, half tracks and custom speeds survive, so copy protections that depend on them still see them |
| `.crt` | Cartridge | Expansion port | ✅ | — | See Peripherals for the boards |
| `.g41` | Disk | A 1541 (device 8-11) | ✅ | ✅ | A G64 under another name (the `GCR-1541` format), read and saved as one |
| `.d71` | Disk | A 1571 (device 8-11) | ✅ | ✅ | 349,696 bytes: a `.d64` for each side, the second side's tracks numbered 36-70 on the same 35 cylinders (a 1,366-byte error table after them is read as a `.d64`'s is). Saved as `.d71` while every sector of both sides can still be read; a disk that no longer can be is refused with that message rather than lose a side. A blank one has the DOS's double-sided flag, the second side's free counts in 18/0 and its bit maps in 53/0 |
| `.d81` | Disk | A 1581 (device 8-11) | ✅ | ✅ | 819,200 bytes of 256-byte sectors (a 3,200-byte error table after them is dropped): logical track *t* is cylinder *t*-1, its 40 sectors the first 20 on side 0 and the rest on side 1, a pair to each 512-byte sector. Saved as `.d81` while every track still has ten sectors of 512 bytes |
| `.c64state` | Snapshot | Machine | ✅ | ✅ | zx84's own exact save state, including the drive (its CPU, its chips and the disk) when one is fitted and the cartridge, with its bank state, when one is |

**Save menu exports:** snapshot (`.c64state`), tape (`.tap`), screenshot (PNG), RAM (`.bin`).

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Tape auto-PLAY and turbo | ✅ | PLAY is pressed for you when the KERNAL polls the tape port; load time shrinks with the turbo setting |
| Disk turbo | ✅ | Runs flat out while a drive's motor is on and its controller is moving bytes or the serial bus is carrying a file (a 1581 reads a sector in a blink and then spends most of a second sending it), as the tape does |
| Drive LED and sounds | ◐ | LED, motor and head track in the status bar and Drives pane; the shared floppy sound (5.25-inch motor and head steps, when floppy sounds are on) follows the motor and track. Not listened to |
| Border size | ✅ | Normal, small, none |
| Colour map | — | The sixteen VIC-II colours are fixed |
| Programs in the Library | ✗ | No library for the 64 |
| Cartridge persistence | ✗ | A cartridge is not kept across a browser reload; snapshots carry it |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | The 6502 family service, with the full 64K the CPU sees (ROM and I/O as banked) |
| Trace | ✅ | Full and port-I/O modes |
| Beam debugging | ✅ | `beam_log`, `interrupt_log` and `run` with `until_line`: 312 lines × 63 cycles per frame |
| Screen OCR / TEXT overlay | ◐ | Character modes only: reads the VIC-II's view of screen and character RAM and matches glyphs against the ROM font in both sets, including reverse video, extended-colour text and a scrolled display. Multicolour cells and bitmap modes read as nothing |
| BASIC Listing / Variables panes | ✅ | BASIC V2, read from RAM through the zero-page pointers (`$2B` `$2D` `$2F` `$31`): the detokenised program (control codes spelled as `petcat` does: `{clr}`, `{red}`), simple variables (reals as BASIC prints them, integers, strings), arrays with their dimensions, and FOR loops in progress with their TO and STEP |
| Machine-specific panes | ✅ | Memory map (banking, VIC bank, screen base, the cartridge and what its lines make of the map), Tape, Drives, Joystick, Mouse, ROM / Carts, Keyboard, Hardware. Microdrive, system-variable and font panes are hidden |
| MCP tools | ✅ | The generic tools (`registers`, `step`, `disassemble`, `memory`, `trace`, `beam_log`, `ocr`, `screenshot`, `type`, `key`, `load`, `eject`) plus `c64sid` (`6581` or `8580`), `chip_state` (`vic`, `sid`, `cia1`, `cia2`, `pla`, `cart` with a cartridge and `drive` with a 1541) and `c64drive` (`on`, `off`, `status`, with `model` `1541` or `1581`, or `models` a list of up to four; `load` and `eject` take `drive` 0-3 or A-D) and a chip for each drive (`drive`, `drive9`, `drive10`, `drive11`); `model` takes `tv` (`pal`, `ntsc`), and `load` takes `.crt`. `type` enters the character the key makes, so `LOAD""` is typed as written |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| No real-time check of audio or typing in the browser | SID, keyboard | low | Verified headlessly (frame-driven) and by tests; the SID has not been listened to by a person |
| Idle drives cost emulation speed | 1541, 1571, 1581 | low | Each drive's 6502 and chips run in lock-step with the 64: about 12% for a 1541 (17.7× real time against 20× with no drive) and about a third for a 1581 (13.4×), whose CPU runs at twice the clock. A 1571 costs a little more than a 1541, and a little more again in its 2 MHz mode (in one run 4.9× and 4.6× real time against 5.1× with a 1541 and 7.0× with no drive). Four drives cost four times that |
| The 1581's controller has no byte clock | 1581 | low | Reads and writes are sector-level and instant; a protection that times the controller, or relies on lost data, cannot be seen. Seeks complete at once, so a 1581 loads faster than the real one |

## Not emulated

- The older NTSC 6567R56A (64 cycles a line), and the 6572/6573 variants.
- Cartridge boards other than those listed (Action Replay, Final Cartridge III, the freezers, REU, GMod and the rest); writing to an EasyFlash's flash chips.
- User port and RS-232; the light pen; paddles and other analogue devices (the POT lines read as full scale unless a 1351 mouse is in).
- The 8580's own combined-waveform tables and its measured filter (it is the 6581's voices with a linear, DC-free filter and mixer), and the 6581 revisions' differences from each other.
- Datasette sound.
- Other drives: the 1541-II, the 1570 and 1571CR, the IEEE-488 drives (2031, 4040) and the third-party ones. There are up to four drives, devices 8 to 11, each a 1541, a 1571 or a 1581; `.x64`, `.g71`, device numbers changed in software (the DOS's `M-W` device-change command is not followed), the burst (fast serial) mode of the 1571 and 1581 (the CIA is there, but only a C128 drives it) and MFM disks in a 1571 are not emulated.
- Disk and program formats beyond `.d64`, `.g64`/`.g41`, `.d71`, `.d81`, `.t64`, `.prg`, `.tap` and `.crt`: of what the TOSEC collections hold, `.p00`/`.p01` (PC64 files), `.lnx` (Lynx archives), `.z64` (Zipcode sets) and the `.c64` files are not read.
- C128 and VIC-20 (separate machines, not part of this one).

## Faithful quirks

- **Bad-line hold is 43 cycles** — the VIC-II takes the bus for cycles 11–54 of a bad line and the CPU is stopped for the whole window (not twice, which an earlier version charged); the serial-bus loops in the 1541 transfer code depend on it.
- **DATA is held low by hardware** — when ATN and ATNA disagree the 1541's gate pulls DATA low before any firmware runs; that is how the drive "answers" ATN. The 1581's gate differs: it pulls DATA while ATN is held and ATNA is set.
- **A 1581 does not notice a disk until its head steps** — the disk-change line stays set across the DOS's own start-up self-test (a restore from track 0 sends no step pulse), so the first disk in the drive is found; and the DOS compares the controller's READ ADDRESS CRC, so the model returns the real CRC of the ID field.
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
| [`tests/c64/c64-1581.test.ts`](../../tests/c64/c64-1581.test.ts) | The `.d81` codec (geometry, the 256-byte sector pairing, round trips, a blank disk); the real 1581 DOS: `LOAD"$",8`, `LOAD` and `RUN`, a 20 KB file across tracks and sides, `SAVE` and reload with an exact `.d81` export, write protect, a changed or removed disk, `N:` format, the Drives pane feed and disk turbo, exact snapshot restore; the model choice (which ROM is asked for, switching empties the drive, snapshots refuse the other drive), media routing and the chip dump. The three real `.d81` games in the TOSEC set were also loaded by hand: all list their directories, and `LOAD"*",8,1` and `RUN` reach their bitmap screens | 2026-10-29 |
| [`tests/c64/c64-1571.test.ts`](../../tests/c64/c64-1571.test.ts) | The `.d71` codec (two sides numbered 36-70, error table, blank-disk BAM, refusing a damaged one), routing of `.d64`/`.d71`/`.d81` across a mix of drives, the 2 MHz time base, the side and clock bits of VIA 1 port A, snapshots; the real 1571 DOS: its error channel, a 1541-mode first side, then `U0>M1` and `LOAD"$",8`, `LOAD` and `RUN` from either side, `SAVE` and an `N:` format of both sides | 2026-10-29 |
| [`tests/c64/c64-ntsc.test.ts`](../../tests/c64/c64-ntsc.test.ts) | NTSC timing constants, the `us` locale building the NTSC machine, 263 × 65 cycles a frame, the 43-cycle bad line, snapshot standard check; with the real ROMs the KERNAL reports NTSC, the jiffy clock keeps 60 a second, and the 1541 lists a directory | 2026-10-29 |
| [`tests/c64/c64-cartridge.test.ts`](../../tests/c64/c64-cartridge.test.ts) | `.crt` parsing and refusals, the 8K, 16K and Ultimax maps (booting from an Ultimax reset vector), every supported board's banking, media service and slot, snapshot with a cartridge; with the real KERNAL a cartridge autostarts through `CBM80`. The cartridges are built by hand, not real dumps | 2026-10-29 |
| [`tests/c64/c64-keyboard-pane.test.ts`](../../tests/c64/c64-keyboard-pane.test.ts) | The caps cover every matrix key once, sit inside the scene without overlap; latching, SHIFT LOCK, RESTORE and release-all against a machine; with the real KERNAL, caps type `10 PRINT"HI"` and `RUN`. The pane itself was seen and clicked in the browser | 2026-10-29 |
| [`tests/c64/c64-sid-8580.test.ts`](../../tests/c64/c64-sid-8580.test.ts) | The 8580 option: model switch keeps the registers, no DC level on the 8580 where the 6581 has one, a 2 kHz saw is cut far harder at FC 512 on the 6581 than on the 8580, the two meet at the top of the range, the machine follows `c64-sid`, the dump names the chip. The curves have not been compared against hardware or reSID's output | 2026-10-29 |
| [`tests/c64/c64-mouse.test.ts`](../../tests/c64/c64-mouse.test.ts) | POT counters, port selection, wrap and flick limit, buttons on the port's lines | 2026-10-29 |
| [`tests/c64/c64-ocr-joystick.test.ts`](../../tests/c64/c64-ocr-joystick.test.ts) | TEXT overlay on the boot screen and a `LIST`, joystick port defaults | 2026-10-28 |
| [`tests/c64/mos6526.test.ts`](../../tests/c64/mos6526.test.ts), [`mos6581.test.ts`](../../tests/c64/mos6581.test.ts) | CIA timers, ICR, time of day; SID voice 3 read-back, TEST, noise and envelope | 2026-10-28 |

Tests that need the Commodore ROMs read them from `mcp/.cache` (the copies from VICE) and skip when absent.
