# Apple II family

Apple's 6502-based home computer and its successors. zx84 emulates the original
Apple ][, the ][+, the unenhanced and Enhanced //e and the //c, with a bit-level
Disk ][ controller, the //e's memory management unit and auxiliary RAM, composite
colour video, and a handful of period expansion cards.

| | |
| --- | --- |
| **Manufacturer** | Apple Computer |
| **Released** | 1977–1985 |
| **CPU** | MOS 6502 (Apple ][, ][+, //e) or CMOS 65C02 (the Enhanced //e's base part; the //c's Rockwell R65C02, with its bit instructions) — 1.022727 MHz |
| **zx84 kind** | `apple2` — [`src/machines/apple2/`](../../src/machines/apple2/) |
| **Model ids** | `apple2` `apple2-plus` `apple2e` `apple2e-enhanced` `apple2c` — the MCP `model` target and `?model=` value |
| **Accuracy** | Instruction-level CPU with per-instruction cycle counts, the cycle of each bus access worked out from the opcode; 65 cycles × 262 lines = 17,030 cycles per frame. The picture is built as the beam goes, at the Display pane's accuracy: **High** (default) fetches each of a line's 40 columns on its own cycle, **Mid** builds a line at its end, **Low** draws the whole frame at its end (turbo always draws at Low). The video scanner's address is known on every cycle, which is what an undriven read returns (the floating bus) |
| **Status** | Working — boots disk images with the real ROMs; see Verification |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Apple ][ (`apple2`) | 1977 | 48 KB; optional 16 KB language card | 12 KB (Integer BASIC + original Monitor) | 40-column upper-case text, lores, hires | 1-bit speaker | Disk ][ (slot 6), cassette | No Autostart: mounting a disk in drive 1 resets and jumps to `$C600`, as typing `C600G` would |
| Apple ][+ (`apple2-plus`) | 1979 | 48 KB; optional 16 KB language card | 12 KB (Applesoft + Autostart Monitor) | As the ][ | 1-bit speaker | Disk ][, cassette | Autostart Monitor scans the slots and boots a disk on reset |
| Apple //e (`apple2e`) | 1983 | 64 KB (48 KB + built-in language card); 64 KB auxiliary RAM with the extended 80-column card | 16 KB (`$C000`–`$FFFF`) incl. 80-column firmware | Lower case, alternate character set, 80-column text, double hi-res | 1-bit speaker | Disk ][, cassette | NMOS 6502. Full ASCII keyboard with CAPS LOCK; Open-Apple / Solid-Apple / SHIFT read as game buttons 0–2 |
| Apple //e Enhanced (`apple2e-enhanced`) | 1985 | As the //e | 16 KB | As the //e, plus MouseText in the alternate character set | 1-bit speaker | Disk ][, cassette | 65C02 (the base CMOS set; Apple documented nothing beyond it) and updated ROMs. `$C07F` reads DHIRES back |
| Apple //c (`apple2c`) | 1984 | 128 KB (64 KB main + 64 KB auxiliary) | 16 KB-class image, internal ROM always at `$C100`–`$CFFF` | As the Enhanced //e | 1-bit speaker | Built-in Disk ][ drive (+ optional external drive), cassette | Rockwell R65C02 (RMB/SMB/BBR/BBS run). No expansion slots; Disk ][, 80-column hardware, auxiliary RAM and language card are always present and cannot be turned off |

### ROM sets

Every ROM below is fetched from the ROM host at `apple2/<file>` when the
machine is built. The system ROM can be replaced with a user-supplied full image
from the ROM pane (the pane shows a single "System ROM" entry; there are no
per-page slots). Apple II models have no locale variants.

| Model | System ROM | Character generator | Notes |
| --- | --- | --- | --- |
| `apple2` | `apple2.rom` (12 KB, `$D000`–`$FFFF`) | `chargen.rom` | |
| `apple2-plus` | `apple2plus.rom` (12 KB) | `chargen.rom` | |
| `apple2e` | `apple2e.rom` | `apple2e-video.rom` | An image of 16 KB or more: first 4 KB is the internal `$C000`–`$CFFF` ROM, the next 12 KB is `$D000`–`$FFFF` |
| `apple2e-enhanced` | `apple2e-enhanced.rom` | `apple2e-enhanced-video.rom` | Same layout as the //e |
| `apple2c` | `apple2c.rom` | `apple2e-enhanced-video.rom` | Same layout as the //e; internal firmware also holds the Disk ][ boot code |

Other ROMs fetched on demand: `disk2.rom` (256-byte Disk ][ controller ROM, slot
6, only when the controller is fitted and not on the //c), `videx-videoterm.rom`
(1 KB firmware) and `videx-chargen.rom` (2 KB character ROM), both only when the
Videx card is fitted. Without the character generator ROM text renders blank
rather than failing.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| MOS 6502 CPU | `apple2`, `apple2-plus`, `apple2e` | ✅ | [`src/cores/m6502.ts`](../../src/cores/m6502.ts). Official opcodes plus the stable undocumented ones (SLO, RLA, SRE, RRA, SAX, LAX, DCP, ISC, ANC, ALR, ARR, AXS); NMOS decimal-mode Z quirk |
| 65C02 CPU | `apple2e-enhanced`, `apple2c` | ✅ | [`src/cores/m65c02.ts`](../../src/cores/m65c02.ts), in the part each machine had. The base CMOS set (BRA, PHX/PHY/PLX/PLY, STZ, TSB/TRB, INC A/DEC A, BIT immediate/indexed, JMP (abs,X), `(zp)` mode, valid decimal flags, D cleared by BRK/IRQ) is the Enhanced //e's (`g65sc02`, the GTE/Synertek-style part): every other unassigned opcode is a NOP of the length and time the datasheets give (`$x3 $x7 $xB $xF` one byte one cycle; `$x2` two/two; `$44` two/three; `$54 $D4 $F4` two/four; `$5C` three/eight; `$DC $FC` three/four). The //c's Rockwell R65C02 (`r65c02`) adds RMB0-7/SMB0-7 (`$x7`, 5 cycles) and BBR0-7/BBS0-7 (`$xF`, 5 cycles, +1 taken, +2 taken across a page). The WDC W65C02S's WAI/STP (`$CB`/`$DB`, `w65c02s`, with its bit instructions) are in the core with their wake-up rules, but no Apple II model had that part, so none selects it |
| Soft-switch decode (`$C000`–`$C0FF`) | all | ✅ | [`apple2-io.ts`](../../src/machines/apple2/apple2-io.ts) (][, ][+); [`apple2e-io.ts`](../../src/machines/apple2/apple2e-io.ts) (//e family). The ][ and ][+ decode in sixteen-address blocks (keyboard `$C000`–`$C00F`; strobe clear, cassette out, speaker and game strobe at every address of `$C01x`–`$C04x`; paddle trigger `$C07x`) and have **no** read-back of the display switches and no vertical-blanking flag; reads of what drives nothing return the floating bus. The //e family decodes `$C000`–`$C01F` as keyboard data with the status in bit 7 |
| Video scanner / floating bus | all | ✅ | [`apple2-scanner.ts`](../../src/machines/apple2/apple2-scanner.ts): the RAM address the scanner reads on every cycle of the frame (text, lores, hires, mixed, PAGE2; the first two cycles of blanking read the same byte, the 24 before a row read the 24 bytes just below it wrapping inside its 128-byte segment, `$1000` higher in text and lores on the ][ and ][+; the 70 vertical-blanking lines read from 8 bytes below each segment row's start). A read that nothing drives returns that byte, taken at the read's own cycle (an indexed load that crosses a page falls a cycle later): unclaimed `$C0xx` switches, empty slots' `$Cn00` pages and `$C800`, the language card's switches, the Disk ][ card's odd addresses (its data register answers even ones only), and on the //e the auxiliary RAM when the card is absent. The 74LS251 game inputs `$C060`–`$C06F` and the //e's `$C011`–`$C01F` and `$C07F` drive bit 7 only (on the //e the other bits of `$C011`–`$C01F` are the last key's code). The //e's 80-column fetch of auxiliary RAM is not on the bus: it is main RAM's byte |
| Memory map | all | ✅ | 48 KB main RAM below `$C000`; slot ROM pages `$C100`–`$C7FF`; shared expansion area `$C800`–`$CFFF`; ROM or language-card RAM at `$D000`–`$FFFF` |
| 16 KB language card | `apple2`, `apple2-plus` (optional); built in on all //e-family models | ✅ | Two 4 KB `$D000` banks plus 8 KB at `$E000`; `$C080`–`$C08F` switches, writes enabled only after two consecutive reads of an odd switch. Separate auxiliary language-card RAM (ALTZP) on the //e family |
| MMU and auxiliary RAM | `apple2e`, `apple2e-enhanced`, `apple2c` | ✅ | 80STORE, RAMRD, RAMWRT, INTCXROM, ALTZP, SLOTC3ROM, with status read-back at `$C011`–`$C018` and the INTC8ROM latch. Auxiliary RAM exists only with the extended 80-column card (always on the //c); without it the auxiliary side reads `$FF` and ignores writes. [`apple2e-memory.ts`](../../src/machines/apple2/apple2e-memory.ts) |
| Video generator | all | ✅ | 40-column text, lores, hires (pages 1 and 2), mixed mode, flashing and inverse text (flash toggles every 16 frames). //e family adds 80-column text, double lo-res, double hi-res and the alternate character set. Frame buffer is 560 × 192 plus a border; 280-dot modes are pixel-doubled. Every line is fetched column by column with the switches and memory as they are when its column is fetched, so a switch or write in mid-frame (or mid-line, at High) shows from where the beam had got; a line whose columns came from different modes is decoded as one 560-dot composite stream. [`apple2-video.ts`](../../src/machines/apple2/apple2-video.ts) |
| Character generator | all | ✅ | 2513-style 64-glyph upper-case ROM on the ][ and ][+; 256-glyph ROM with lower case on the //e; Enhanced //e and //c use a ROM with MouseText at `$40`–`$5F` |
| Speaker | all | ✅ | 1-bit toggle on `$C030`, accumulated per CPU cycle |
| Cassette interface | all | ◐ | `$C060` input from a comparator over a `.wav` recording. The comparator has hysteresis — a dead band of 0.3 × the recording's mean level — so noise on a digitised tape does not chatter; output `$C020` toggles (read or write) are timed on the access's own cycle and recorded since the last reset, for the Save menu |
| Keyboard | all | ✅ | Encoder latch + strobe at `$C000`/`$C010`. ][/][+: upper case only. //e family: full ASCII, locking CAPS LOCK (down at power-on), control codes, arrow keys |
| Game port | all | ◐ | Push buttons `$C061`–`$C063`, four paddle timers `$C064`–`$C067` (11 CPU cycles per count plus 8, so the Monitor's PREAD returns the position, 0–255), trigger `$C070`, all timed on the access's own cycle. Annunciators AN0–AN3 at `$C058`–`$C05F` are latches (even address off, odd on; on the //e AN3 is also the double hi-res switch) whose state is kept but drives nothing. The utility strobe (`$C040`; the whole `$C040`–`$C04F` block on the ][ and ][+, `$C040` only on the //e, none on the //c) pulls its line low for the access's cycle: nothing is plugged in, so the cycle of the last pulse (`strobeAt`) and a count (`strobes`) are kept as observable state for tests and the debugger, and saved in `.a2state` |
| Vertical-blank status | `apple2e`, `apple2e-enhanced`, `apple2c` | ✅ | `$C019` RDVBLBAR: high while the beam is drawing, low from the first cycle of line 192, judged on the cycle of the read (not the instruction's first cycle). The ][ and ][+ have no such flag: their `$C019` is the floating bus, and a program finds the beam by polling it for a known byte |
| Interrupts | all | ✅ | No motherboard interrupt sources. IRQ is driven only by the Mockingboard's 6522 timers |

---

## Peripherals

Fitted in the Hardware pane. Every change rebuilds the machine; mounted disks
carry over.

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Disk ][ controller (slot 6) with 1 or 2 drives | Disk | `apple2`, `apple2-plus`, `apple2e`, `apple2e-enhanced` (optional, on by default); `apple2c` (built in) | ✅ | Bit-level: each track is a stream of 4 µs bit cells turning under the head at 4 CPU cycles a cell, timed from the exact cycle of every access (so it keeps turning between reads). Behavioural model of the logic state sequencer: data register shifting, a finished byte held through 0 cells until a 1 restarts it (at least two cells), MC3470 random bits after more than three cells without a flux transition, write-protect sense, writes laid down cell by cell with the software's own timing (32-cycle bytes, 40-cycle self-sync). Four stepper magnets position the head on 160 quarter tracks (two adjacent magnets hold it between them); motor with about 1 second of spin-down. One or two drives, chosen from the Drives pane's **Drive count** menu (rebuilds the machine); the //c's second drive is its external one |
| Language card (slot 0) | RAM | `apple2`, `apple2-plus` | ✅ | On by default; checkbox in the Hardware pane. Built in on the //e family |
| Videx Videoterm (slot 3) | 80-column video | `apple2`, `apple2-plus` | ✅ | 6845 CRTC, 2 KB card RAM behind a 512-byte window at `$CC00`, 1 KB firmware, 2 KB character ROM. 80 × 24 characters of 7 × 9 dots with inverse video and a cursor, shown once `PR#3` has programmed 80 columns |
| Extended 80-column card (64 KB) | RAM / video | `apple2e`, `apple2e-enhanced` | ✅ | On by default. Provides auxiliary RAM for 80-column text, double hi-res and 128 KB software; built in on the //c |
| Mockingboard (slot 4) | Sound | `apple2`, `apple2-plus`, `apple2e`, `apple2e-enhanced` | ✅ | Model A: two 6522 VIAs each driving an AY-3-8910 (left and right), VIA timer interrupts on the IRQ line. Not offered on the //c |
| Paddles / joystick | Input | all | ✅ | On by default. A gamepad's analogue stick sets the paddles proportionally; keys, the on-screen pad and a D-pad drive an axis to an end stop and releasing centres it (127). X reads 0 at full left and 255 at full right, Y 0 at full up. Player 1 = paddles 0/1 + button 0, player 2 = paddles 2/3 + button 1. The Mouse pane's **Mouse as paddles** captures the host mouse (pointer lock): it moves paddle 0 (left/right) and paddle 1 (up/down) from where they are, one count per host pixel, stopping at 0 and 255, and its left and right buttons are push buttons 0 and 1. Without the paddles option, paddle reads time out at full scale and buttons never close |

**Combination rules:** each card has a fixed slot (language card 0, Videx 3,
Mockingboard 4, Disk ][ 6), so cards never conflict. The Videx card is offered
only on the ][ and ][+; the extended 80-column card only on the //e and Enhanced
//e. On the //c the Hardware pane offers only paddles; Disk
][, 80-column hardware, auxiliary RAM and the language card are forced on and the
Mockingboard forced off. On the //e family `$C300` shows the built-in 80-column
firmware unless SLOTC3ROM selects slot 3.

---

## Media formats

ZIP archives are unpacked; the first loadable entry is mounted, with a picker
when there are several.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.dsk` | Disk | Disk ][ drive 1 or 2 | ✅ | ✅ | 140 KB 16-sector image; sector order detected from the contents, not the extension. Save writes `.po` for ProDOS order, otherwise `.dsk` |
| `.do` | Disk | Disk ][ drive 1 or 2 | ✅ | ✅ | Saved as `.dsk` (or `.po` if the contents are detected as ProDOS order) |
| `.po` | Disk | Disk ][ drive 1 or 2 | ✅ | ✅ | Order is detected from the contents; a DOS-order dump named `.po` is saved as `.dsk` |
| `.d13` | Disk | Disk ][ drive 1 or 2 | ◐ | ✅ | 13-sector DOS 3.1-3.2.1 image (116,480 bytes, physical sector order), nibblized with `D5 AA B5` address fields and 5-and-3 data fields. Mounts, reads and writes, but does not boot: see Not emulated |
| `.nib` | Disk | Disk ][ drive 1 or 2 | ✅ | ✅ | Raw nibbles, 35 (or 40) tracks of 6,656 bytes (6,384-byte `.nb2` tracks too). Gap `$FF`s become ten-cell self-sync bytes again; `$FF`s inside address and data fields stay eight cells. Saved as `.nib` (each track's nibbles as a reader collects them) |
| `.woz` | Disk | Disk ][ drive 1 or 2 | ✅ | ✅ | WOZ 1, WOZ 2 and WOZ 2.1: CRC-32 checked (a zero CRC is accepted), INFO (write protect, optimal bit timing, creator), TMAP quarter tracks, TRKS bit streams, WOZ 2.1 FLUX tracks (each transition interval rounded to whole cells) used in place of the bit track for their quarter tracks; META kept. 3.5" WOZ disks are refused. Saved as WOZ 2 with every written cell |
| `.2mg` / `.2img` | Disk | Disk ][ drive 1 or 2 | ✅ | ✅ | 64-byte header around a 140 KB DOS- or ProDOS-order image or a `.nib`; the locked flag sets write protect and a header volume number is used for the address fields. Saved as `.2mg` with the header, comment and creator data kept. Larger (3.5", hard-disk) images are refused |
| `.a2state` | Snapshot | Machine | ✅ | ✅ | zx84's own exact save state, every model (see below) |
| `.wav` | Tape | Cassette deck | ✅ | ✅ | FSK audio; one logical block with play, pause, stop and rewind. Save is a recording of the `$C020` toggles since the last reset (`apple2-tape.wav`: 44.1 kHz 16-bit mono square wave, silences between saves cut to 1 s), not a re-save of the mounted tape |

The format is decided by the contents (a WOZ or 2MG header, a `.nib` or `.d13`
length), not the extension. Every disk becomes a set of bit-cell tracks on a
quarter-track map: a sector image is nibblized DOS-style (48 self-sync bytes,
then per sector the address field, 6 sync, the data field and 20 sync, padded
with sync to 51,136 cells, one 300 RPM revolution at 4 cycles a cell), each
track readable from its own quarter track and the ones either side, half tracks
blank, as in WOZ images of standard disks. Sector images: 35-track (or 40-track) images, with a few stray bytes tolerated
(within 1 KB of a whole number of tracks). A MacBinary I header or a
`SIMSYSTEM_IIE` prefix is read through. Order is chosen from a ProDOS volume
header at block 2, else from which skew makes the DOS 3.3 catalog chain readable,
else DOS order. The address-field volume number is taken from the DOS boot IOB or
the VTOC (default 254). Mounting in drive 1 (`unit:0`) resets and boots the disk; mounting in
drive 2 (`unit:1`) does not. A mount fails if the Disk ][ controller is not fitted or the
drive is not present. Write-protect can be set per drive (a WOZ or 2MG image's
own flag sets it on mount, and is saved with it); written tracks are decoded and
folded back into the sector image once per frame, and Save from the Drive pane
downloads the modified image in the format it was loaded as. Writing over a
blank quarter track lays down a new track there (kept by `.woz`, not by sector
formats). Mounted tapes and disks are restored after a reload.

**Snapshots.** `.a2state` is zx84's native save state for every model, in the same container as the Atari's `.a8state` (a CRC-32 and length checked before the machine is touched, deflated when saved from the Save menu),
magic `ZXA2`: the 6502 or 65C02, the soft switches (display, //e 80-column,
alternate characters, double hi-res), main RAM and the language card (RAM and
switches, including the half-done double read that enables writing), on the
//e the auxiliary RAM and MMU switches, the keyboard latch and strobe, the game
port (paddle timers, annunciators, the sticks and buttons as held), the
Mockingboard (both VIAs and both AYs), the Videx card (CRTC registers and its
RAM), the Disk ][ (each head's quarter track and bit position, the stepper
magnets, motor and spin-down, Q6/Q7, the data register, the read amplifier's
noise window), the cassette deck and what has been written to the cassette
output, and the frame grid. A file saved from the Save menu also carries the
disks in their bit-level form (every track's cells as written, the quarter-track
map and what a save needs to write them back in their own format) and the
tape, stored as the run of levels the comparator settles on. A state names its
model, and loading one on another model switches to it first; a state saved
with other cards or another drive count is refused until the Hardware or
Drives pane matches. The header records the CRCs of the system, internal,
Disk ][ and Videx ROMs (a mismatch loads with a warning). A state is taken
between frames and restores cycle for cycle. The same state without the media
backs browser-refresh resume; the shell then remounts the persisted disks
without a reboot or a head move.

**Save menu exports:** Snapshot `.a2state`; Saved tape (`.wav`); PNG screenshot; RAM `.bin` (the 48 KB of main RAM, named
`<model>-ram-48k.bin`).

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| CPU timing | ✅ | Cycle count per instruction; frame is 17,030 cycles and the frame loop is paced at the machine's own 60.05 Hz (1,022,727 Hz ÷ 17,030), not the 50 Hz default. Disk bit clock, paddle timers, cassette and Mockingboard timers run from the CPU cycle count |
| Display modes | ✅ | NTSC composite (artefact colour decoded from the 1-bit dot stream), PAL composite, monochrome (white) and green phosphor, chosen in the Display pane. PAL changes the colour decoder only; timing stays at 262 lines |
| Lores colours | ✅ | Fixed 16-colour table in both composite modes; 16 luminances in monochrome and green |
| Double hi-res | ✅ | 560 dots across, auxiliary byte then main byte per 14-dot cell; colour decoded from every four dots in composite modes. Checked against the lores palette: the dots of a lores nibble (bit n on every dot whose number mod 4 is n) decode to that nibble's colour |
| Double lo-res | ✅ | `80COL` on, `TEXT` and `HIRES` off, AN3 off (`$C05E`): 80 blocks across, the auxiliary RAM nibble left of the main one in each pair, low nibble for a block's top four lines. The auxiliary nibble shows as the colour of its value rotated left one place (aux `$1` looks like main `$2`, aux `$8` like main `$1`). With 80COL on but AN3 on, lores stays 40-column. Drawn from the fixed 16-colour table like lores |
| 80-column text | ✅ | Even columns from auxiliary RAM, odd from main; drawn white (or green) without colour fringes |
| Border size | ✅ | None / small / normal (shared border control) |
| Fast loading / turbo loading | ✗ | Cassette and disks run in real emulated time; no trap or accelerator |
| Tape sound | ✗ | `tapeSound` is off for this machine |
| Media persistence | ✅ | Mounted disks and tape come back after a reload |
| Disk activity indicators | ✅ | Per-drive LED and track number; disk sounds from the shared 5.25-inch floppy model |
| Status LEDs | ✅ | KEY (lit when the program polls `$C000`, not when a key is held), DSK, BEEP, TEXT |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger | ✅ | 6502 debug substrate: breakpoints, memory watchpoints (read, write or either; the frame stops after the accessing instruction), step into, step over (JSR only), step out, registers A X Y P SP PC with flags, disassembly of a side-effect-free snapshot of the current memory mapping (65C02 mnemonics on the CMOS models), memory view with the Apple II character table |
| Trace | ✅ | Full (address, disassembly, registers, cycles and operand context, with interrupt entries marked and tight loops folded) and an I/O tally of the CPU's reads and writes in C000-C0FF (the soft switches and slot I/O) — the shared 6502 trace engine; no ZXTrace, which is a Z80 layout; a trace stops capturing at 500,000 lines |
| Screen OCR / TEXT overlay | ✅ | Reads the text page directly, exact with no pattern matching: 40 or 80 columns, //e alternate character set (MouseText cells left unmasked), the lower four rows in mixed mode, and the Videx card's screen when active |
| Software library | ✗ | Not offered for this machine |
| On-screen keyboard | ✅ | Three layouts (][/][+, //e, //c) with RESET, REPT (][ family), CAPS LOCK and Open/Solid-Apple. Modifiers latch for one keystroke so CTRL-RESET is clickable. The //c's 80/40 and keyboard switches and lamps are drawn but not wired |
| Hidden panes | ✅ | Microdrive, mouse, system-variable, font, banks and BASIC panes are not shown |
| MCP tools | ◐ | Generic: `model`, `run`, `step_frame`, `step`, `continue`, `registers`, `set_register`, `read_memory`, `write_memory`, `find`, `disassemble`, `breakpoint`, `delete_breakpoint`, `memory_watchpoint`, `delete_memory_watchpoint`, `trap`, `trap_delete`, `trap_log`, `trap_respond`, `key`, `type`, `load` (with `drive`), `eject`, `screenshot`, `ocr`, `symbols`, `symbols_load`, `chip_state` (`gameport`: paddles, buttons, annunciators and the utility strobe; `video`: switches, the beam and the scanner's address). `port_in` and `port_out` decline (no I/O port space). `save` is Spectrum-only. No machine-specific tools |
| Drive count | ✅ | One or two drives on the Disk ][ controller, from **Drive count** in drive 1's options menu; saved, rebuilds the machine |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| MCP `key` combinations and `type` punctuation or capitals do not apply modifiers | All (MCP only) | low | The tools press a modifier as a separate key event, so the Apple II keyboard (which reads modifiers from each event) sees plain keys: `sym+p` gives `P`, not Ctrl-P. The `type` tool describes its symbol chords as Spectrum mappings |
| Disk ][ sequencer is behavioural, not the P6 PROM | All with Disk ][ | low | Documented in `peripherals/disk2.ts`: bits move a whole 4 µs cell at a time, so where within a cell a transition or a CPU access falls is not modelled |
| The head moves the instant a phase changes | All with Disk ][ | low | No stepper settling time or inertia: a protection that times a seek, or relies on the head overshooting, sees an ideal drive. Left alone on purpose: the Shugart SA390's step and settle times are not in any reference at hand, and a guessed constant would be a half-faithful drive that could break loaders which are fine today |
| 13-sector disks do not boot | All with Disk ][ | low | The 13-sector Disk II boot PROM (P5A) is not in the ROM set, and the 16-sector boot ROM and DOS 3.3 cannot read `D5 AA B5` address fields. The 5-and-3 layout follows the DOS 3.2 structure (154 low-bit values then 256 five-bit values, running XOR) but has not been checked against real DOS 3.2 media |

## Not emulated

- **Game-port outputs.** The annunciator latches drive nothing outside the machine, and the utility strobe's pulse only shows as observable state.
- **//c serial ports, mouse, and its VBL and mouse soft switches.** There is no code for them; slot 1 and 2 I/O reads the floating bus.
- **IOUDIS and `$C07E`.** The Enhanced //e and //c's IOU-disable switch and its `$C07E` read-back are not modelled; `$C07E`/`$C07F` writes do nothing and `$C07E` reads the floating bus. (`$C07F` reads DHIRES on those two models.)
- **Dummy bus accesses.** The 6502 core makes only an instruction's real accesses: an indexed load that crosses a page does not also read the uncorrected address a cycle earlier, which on a soft switch would flip it.
- **//c 80/40 and keyboard-layout switches.** Drawn on the on-screen keyboard only.
- **Other expansion cards.** Only the Disk ][ controller, language card, Videx Videoterm, Mockingboard and extended 80-column card exist (no mouse, clock, serial, hard-disk or CPU cards). The Mockingboard has no speech chip.
- **Other disk formats.** Hard-disk and 3.5-inch images (`.hdv`, 800K `.2mg`/`.po`, 3.5" WOZ) are not accepted: there is no SmartPort or hard-disk card. Flux tracks are turned into bit cells when the WOZ is loaded, so jitter finer than a cell is lost.
- **Snapshots from other emulators.** Only zx84's own `.a2state` (not
  AppleWin's `.aws.yaml`). Keys held on the host are not part of a state.

## Faithful quirks

- **The original ][ does not autostart.** Reset drops into the Monitor; a mounted disk is booted by jumping to `$C600`.
- **//e and //c RESET needs CTRL.** The keyboard passes RESET to the CPU only with CTRL held; RAM survives a reset.
- **Language card write enable.** Writes are enabled only after two consecutive reads of an odd `$C08x` switch; a write access between them restarts the count.
- **Unfitted paddles read full scale.** With nothing in the game port every timer runs to its limit (255) and no button closes.
- **`$C019` is inverted on the //e family, and absent on the ][ and ][+.** On the //e it is high while the beam is drawing; on the ][ and ][+ it is just the floating bus.
- **A read of nothing returns what the video scanner is fetching.** Empty slots, unclaimed switches and the language card's switches give the byte at the scanner's address on the read's cycle, not `$FF` or `$00`; a ][ or ][+ blanking cycle in text or lores reads `$1000` higher than a //e does.
- **The ][ and ][+ mirror their switches.** Any address in `$C010`–`$C01F` clears the keyboard strobe, `$C020`–`$C02F` toggles the cassette output, `$C030`–`$C03F` the speaker, and all of `$C000`–`$C00F` read the keyboard.
- **The Disk ][ drives the bus on even addresses only.** `LDA $C0E9` reads the floating bus; `LDA $C0EC` the data register.
- **The //c has a Rockwell part, the Enhanced //e a base 65C02.** `$B7` is `SMB3` on the one and a one-byte NOP on the other.
- **Disk spin-down delay.** The controller keeps the drive turning for about a second after a motor-off access, which some loaders rely on.
- **Disk volume number.** DOS 3.3's RWTS rejects a disk whose volume differs from the one asked for, so the volume comes from the boot IOB or VTOC, not a constant.
- **NMOS decimal-mode Z flag and `JMP ($xxFF)` page-wrap bug** on the 6502 models; the 65C02 models fix both and clear D on BRK and IRQ.
- **Composite colour artefacts.** A repeated hires byte alternates green and violet per byte; a solid colour needs alternating bytes. Text edges pick up colour fringes in the composite modes, while 80-column text is plain white (the colour burst is off for //e text).
- **The ][ keyboard has its own shift pairs.** SHIFT-2 is `"` and SHIFT-0 is `0`; only N, M and P change their letter with SHIFT, and CTRL affects letters only. The on-screen keyboard follows the ][ table; the host-key mapping follows the PC's shift pairs.
- **Open-Apple and Solid-Apple are the host Alt keys** (left and right); on the //e family they read as game buttons 0 and 1, and SHIFT as button 2.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| `tests/apple2-floating-bus.test.ts` | Scanner addresses worked out by hand from the memory layout (text rows three to a segment, hires scan lines, blanking and its repeated first cycle, the vertical-blanking segment rows, `$1000` on a ][/][+, mixed mode, PAGE2, 80STORE); 6502 code reading an empty slot on planned cycles of a frame against those addresses; the classic loop that polls the bus for a marker at the start of the last text row stops on line 184-191, cycle 25 on the ][+, //e and Enhanced //e; which addresses drive which bits; RDVBLBAR flipping on the exact cycle of line 192; Disk ][ even and odd addresses | Test suite |
| `tests/apple2-accuracy.test.ts` | Double lo-res (geometry, aux nibble rotation, nibble per line, when it applies, page 2, through the machine at all three accuracies), double hi-res dots against the lores palette, which 65C02 part each model has, the `$C040` strobe (cycle, mirrors per model, snapshot, a state saved without it), mouse as paddles | Test suite |
| `tests/m65c02-parts.test.ts` | RMB/SMB, BBR/BBS (every bit, taken or not, page crossing, flags untouched), base-part NOPs, WAI/STP wake-up rules and snapshot, disassembly per part, from the Rockwell and WDC datasheets | Test suite |
| `tests/apple2-video-accuracy.test.ts` | A soft switch flipped mid-line shows from the column the beam had reached at High, from that line at Mid and over the whole frame at Low; a still screen is the same at every accuracy; a stop mid-line changes nothing | Test suite |
| `tests/snapshot/apple2-state.test.ts` | `.a2state` on the ][+, //e and Enhanced //e: synthetic firmware reading a spinning Disk ][ and stepping its head, the Mockingboard's T1 interrupt and AY, the language card, PAGE2 flips, paddles held, annunciators, cassette output and (//e) auxiliary RAM; a restored machine matches the original for 40 frames at every accuracy (registers, cycles, picture, whole state); written bit tracks carried; a state for another model asks for it; damaged files and other cards refused untouched; refresh resume with the disk remounted and no reboot | Test suite |
| `tests/apple2.test.ts` | Registration, memory map, soft switches, cassette deck, hardware options, original ][ boot jump, language card, Videx card, Mockingboard, paddles and joystick, KEY indicator, video addressing and composite/PAL/green rendering, OCR, Disk ][ stepper, GCR stream and spin-down | Test suite |
| `tests/apple2-gameport.test.ts` | PREAD's algorithm reading 0 at full left / up, 255 at full right / down, 127 centred and proportional gamepad positions on all four paddles (and the same on the real Autostart ROM's `$FB1E` when `mcp/.cache/apple2plus.rom` is present); annunciator latches on the ][+ and the //e's AN3 / double hi-res | Test suite |
| `tests/apple2e.test.ts` | //e MMU main/auxiliary paging, ROM and `$C300`/INTC8ROM handling, auxiliary language-card RAM, soft-switch read-back, keyboard, character set, 80-column text and double hi-res | Test suite |
| `tests/apple2-tape-save.test.ts` | A program toggling `$C020` from a table of delays (no ROM): the Save menu's WAV header against the RIFF/WAVE PCM layout, and the WAV mounted back plays into `$C060` with each half-cycle within one output sample of the program's 6502 cycle count; toggles timed on the access cycle; reset clears | Test suite |
| `tests/apple2-cmos.test.ts` | Enhanced //e and //c registration, 65C02 execution through the machine bus, 65C02 disassembly, MouseText, the //c's fixed internal ROM and built-in hardware | Test suite |
| `tests/apple2-disk.test.ts` | GCR/4-and-4/6-and-2 codec against the published definitions, sector skews, length tolerance, MacBinary and SIMSYSTEM headers, sector-order detection, volume number | Test suite |
| `tests/apple2-media-formats.test.ts` | WOZ 1/2/2.1 built byte by byte from the reference (header, INFO, TMAP with blank `FF`, TRKS blocks from block 3, MSB-first bits, CRC-32 from zlib, FLUX intervals), `.nib` sync widening, `.2mg` header fields and save, 5-and-3 code table and sector round trip, `.d13` nibblizing | Test suite |
| `tests/apple2-disk2-lss.test.ts` | Data register hold times (two cells after a byte, four after a self-sync byte), a 7-cycle polling loop seeing every byte once, MC3470 noise after four 0 cells but not three, blank tracks and half tracks read as noise, quarter-track TMAP lookup, a data field written with DOS's 40/32-cycle timing that reads back and saves to `.dsk` and `.woz`, write protect | Test suite |
| `tests/apple2-disk-boot.test.ts` | A 6502 loader in the style of the boot ROM and RWTS (cycle-counted polling, stepper driven phase by phase, 6-and-2 decode on the CPU) loads tracks 0-2 and runs the boot sector from the same disk as `.dsk`, `.po`, `.nib`, WOZ 2 and `.2mg`, on the ][+ and (WOZ) the Enhanced //e. No Apple ROM or disk is needed | Test suite |
| `tests/apple2-keyboard.test.ts` | ][ encoder codes against the Reference Manual table, key release tracking, REPT, RESET on each family | Test suite |
| `tests/m6502.test.ts`, `tests/m65c02.test.ts`, `tests/m6522.test.ts` | NMOS 6502 (flags, decimal, page crossings, interrupts, undocumented opcodes), 65C02 differences and the 6522 VIA, from the datasheets | Test suite |
| Real-ROM disk boots (headless): ][ and //e boot most of a 428-disk TOSEC sample; //e runs many 128K titles; Videx `PR#3` prints 80 columns | Recorded as working; not repeatable from the repo | 2026-10-18 |
| Real-ROM Enhanced //e and //c (headless): //c boots DOS 3.3, `PR#3` gives 80 columns, runs 65C02 code; 103 of 107 sampled disks behave as on the Enhanced //e | Recorded as working; not repeatable from the repo | 2026-10-18 |
| Real-ROM boots after the accuracy work (headless): ][+, //e, Enhanced //e and //c boot DOS 3.3; Applesoft `PEEK` of `$C010` and `$C019` gives the keyboard code and VBL bit on the //e models and the video byte on the ][+; Defender of the Crown's double hi-res title draws on the Enhanced //e | Recorded as working; not repeatable from the repo | 2026-10-31 |
