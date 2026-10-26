# Apple II family

Apple's 6502-based home computer and its successors. zx84 emulates the original
Apple ][, the ][+, the unenhanced and Enhanced //e and the //c, with a bit-level
Disk ][ controller, the //e's memory management unit and auxiliary RAM, composite
colour video, and a handful of period expansion cards.

| | |
| --- | --- |
| **Manufacturer** | Apple Computer |
| **Released** | 1977–1985 |
| **CPU** | MOS 6502 (Apple ][, ][+, //e) or CMOS 65C02 (Enhanced //e, //c) — 1.022727 MHz |
| **zx84 kind** | `apple2` — [`src/machines/apple2/`](../../src/machines/apple2/) |
| **Model ids** | `apple2` `apple2-plus` `apple2e` `apple2e-enhanced` `apple2c` — the MCP `model` target and `?model=` value |
| **Accuracy** | Instruction-level CPU with per-instruction cycle counts; 65 cycles × 262 lines = 17,030 cycles per frame; display rendered once per frame; no user-selectable accuracy setting |
| **Status** | Working — boots disk images with the real ROMs; see Verification |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Apple ][ (`apple2`) | 1977 | 48 KB; optional 16 KB language card | 12 KB (Integer BASIC + original Monitor) | 40-column upper-case text, lores, hires | 1-bit speaker | Disk ][ (slot 6), cassette | No Autostart: mounting a disk in drive 1 resets and jumps to `$C600`, as typing `C600G` would |
| Apple ][+ (`apple2-plus`) | 1979 | 48 KB; optional 16 KB language card | 12 KB (Applesoft + Autostart Monitor) | As the ][ | 1-bit speaker | Disk ][, cassette | Autostart Monitor scans the slots and boots a disk on reset |
| Apple //e (`apple2e`) | 1983 | 64 KB (48 KB + built-in language card); 64 KB auxiliary RAM with the extended 80-column card | 16 KB (`$C000`–`$FFFF`) incl. 80-column firmware | Lower case, alternate character set, 80-column text, double hi-res | 1-bit speaker | Disk ][, cassette | NMOS 6502. Full ASCII keyboard with CAPS LOCK; Open-Apple / Solid-Apple / SHIFT read as game buttons 0–2 |
| Apple //e Enhanced (`apple2e-enhanced`) | 1985 | As the //e | 16 KB | As the //e, plus MouseText in the alternate character set | 1-bit speaker | Disk ][, cassette | 65C02 (G65SC02 subset) and updated ROMs |
| Apple //c (`apple2c`) | 1984 | 128 KB (64 KB main + 64 KB auxiliary) | 16 KB-class image, internal ROM always at `$C100`–`$CFFF` | As the Enhanced //e | 1-bit speaker | Built-in Disk ][ drive (+ optional external drive), cassette | 65C02. No expansion slots; Disk ][, 80-column hardware, auxiliary RAM and language card are always present and cannot be turned off |

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
| 65C02 CPU | `apple2e-enhanced`, `apple2c` | ◐ | [`src/cores/m65c02.ts`](../../src/cores/m65c02.ts). G65SC02 instruction set (BRA, PHX/PHY/PLX/PLY, STZ, TSB/TRB, INC A/DEC A, BIT immediate/indexed, JMP (abs,X), `(zp)` mode). Rockwell/WDC extras (RMB/SMB/BBR/BBS, WAI, STP) execute as NOPs |
| Soft-switch decode (`$C000`–`$C0FF`) | all | ✅ | [`apple2-io.ts`](../../src/machines/apple2/apple2-io.ts) (][, ][+); [`apple2e-io.ts`](../../src/machines/apple2/apple2e-io.ts) (//e family) |
| Memory map | all | ✅ | 48 KB main RAM below `$C000`; slot ROM pages `$C100`–`$C7FF`; shared expansion area `$C800`–`$CFFF`; ROM or language-card RAM at `$D000`–`$FFFF` |
| 16 KB language card | `apple2`, `apple2-plus` (optional); built in on all //e-family models | ✅ | Two 4 KB `$D000` banks plus 8 KB at `$E000`; `$C080`–`$C08F` switches, writes enabled only after two consecutive reads of an odd switch. Separate auxiliary language-card RAM (ALTZP) on the //e family |
| MMU and auxiliary RAM | `apple2e`, `apple2e-enhanced`, `apple2c` | ✅ | 80STORE, RAMRD, RAMWRT, INTCXROM, ALTZP, SLOTC3ROM, with status read-back at `$C011`–`$C018` and the INTC8ROM latch. Auxiliary RAM exists only with the extended 80-column card (always on the //c); without it the auxiliary side reads `$FF` and ignores writes. [`apple2e-memory.ts`](../../src/machines/apple2/apple2e-memory.ts) |
| Video generator | all | ◐ | 40-column text, lores, hires (pages 1 and 2), mixed mode, flashing and inverse text (flash toggles every 16 frames). //e family adds 80-column text, double hi-res and the alternate character set. Frame buffer is 560 × 192 plus a border; 280-dot modes are pixel-doubled. [`apple2-video.ts`](../../src/machines/apple2/apple2-video.ts) |
| Character generator | all | ✅ | 2513-style 64-glyph upper-case ROM on the ][ and ][+; 256-glyph ROM with lower case on the //e; Enhanced //e and //c use a ROM with MouseText at `$40`–`$5F` |
| Speaker | all | ✅ | 1-bit toggle on `$C030`, accumulated per CPU cycle |
| Cassette interface | all | ◐ | `$C060` input from a comparator over a `.wav` recording. The comparator has hysteresis — a dead band of 0.3 × the recording's mean level — so noise on a digitised tape does not chatter; output `$C020` is counted but not recorded (see Not emulated) |
| Keyboard | all | ✅ | Encoder latch + strobe at `$C000`/`$C010`. ][/][+: upper case only. //e family: full ASCII, locking CAPS LOCK (down at power-on), control codes, arrow keys |
| Game port | all | ◐ | Push buttons `$C061`–`$C063`, four paddle timers `$C064`–`$C067` (about 11 CPU cycles per count plus 25), trigger `$C070`. Annunciators and the `$C040` strobe output are ignored |
| Vertical-blank status | all | ✅ | `$C019`: high during blanking on the ][ and ][+; inverted (RDVBLBAR, high while drawing) on the //e family |
| Interrupts | all | ✅ | No motherboard interrupt sources. IRQ is driven only by the Mockingboard's 6522 timers |

---

## Peripherals

Fitted in the Hardware pane. Every change rebuilds the machine; mounted disks
carry over.

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Disk ][ controller (slot 6) with 1 or 2 drives | Disk | `apple2`, `apple2-plus`, `apple2e`, `apple2e-enhanced` (optional, on by default); `apple2c` (built in) | ✅ | Bit-level: stepper phases with half-track positioning, motor with about 1 second of spin-down, 6-and-2 GCR shift register, write-protect sense, write support. One or two drives, chosen from the Drives pane's **Drive count** menu (rebuilds the machine); the //c's second drive is its external one |
| Language card (slot 0) | RAM | `apple2`, `apple2-plus` | ✅ | On by default; checkbox in the Hardware pane. Built in on the //e family |
| Videx Videoterm (slot 3) | 80-column video | `apple2`, `apple2-plus` | ✅ | 6845 CRTC, 2 KB card RAM behind a 512-byte window at `$CC00`, 1 KB firmware, 2 KB character ROM. 80 × 24 characters of 7 × 9 dots with inverse video and a cursor, shown once `PR#3` has programmed 80 columns |
| Extended 80-column card (64 KB) | RAM / video | `apple2e`, `apple2e-enhanced` | ✅ | On by default. Provides auxiliary RAM for 80-column text, double hi-res and 128 KB software; built in on the //c |
| Mockingboard (slot 4) | Sound | `apple2`, `apple2-plus`, `apple2e`, `apple2e-enhanced` | ✅ | Model A: two 6522 VIAs each driving an AY-3-8910 (left and right), VIA timer interrupts on the IRQ line. Not offered on the //c |
| Paddles / joystick | Input | all | ◐ | On by default. Digital only: a direction drives its paddle axis to an end stop and releasing centres it. Player 1 = paddles 0/1 + button 0, player 2 = paddles 2/3 + button 1. Without it, paddle reads time out at full scale and buttons never close |

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
| `.dsk` | Disk | Disk ][ drive 1 or 2 | ✅ | ✅ | 140 KB sector image; sector order detected from the contents, not the extension. Save writes `.po` for ProDOS order, otherwise `.dsk` |
| `.do` | Disk | Disk ][ drive 1 or 2 | ✅ | ✅ | Saved as `.dsk` (or `.po` if the contents are detected as ProDOS order) |
| `.po` | Disk | Disk ][ drive 1 or 2 | ✅ | ✅ | Order is detected from the contents; a DOS-order dump named `.po` is saved as `.dsk` |
| `.wav` | Tape | Cassette deck | ✅ | ✗ | FSK audio; one logical block with play, pause, stop and rewind |

Disk images: 35-track (or 40-track) images, with a few stray bytes tolerated
(within 1 KB of a whole number of tracks). A MacBinary I header or a
`SIMSYSTEM_IIE` prefix is read through. Order is chosen from a ProDOS volume
header at block 2, else from which skew makes the DOS 3.3 catalog chain readable,
else DOS order. The address-field volume number is taken from the DOS boot IOB or
the VTOC (default 254). Mounting in drive 1 (`unit:0`) resets and boots the disk; mounting in
drive 2 (`unit:1`) does not. A mount fails if the Disk ][ controller is not fitted or the
drive is not present. Write-protect can be set per drive; written tracks are
folded back into the image once per frame, and Save from the Drive pane
downloads the modified image. Mounted tapes and disks are restored after a reload.

**Save menu exports:** PNG screenshot; RAM `.bin` (the 48 KB of main RAM, named
`<model>-ram-48k.bin`). There are no machine snapshots.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| CPU timing | ✅ | Cycle count per instruction; frame is 17,030 cycles and the frame loop is paced at the machine's own 60.05 Hz (1,022,727 Hz ÷ 17,030), not the 50 Hz default. Disk bit clock, paddle timers, cassette and Mockingboard timers run from the CPU cycle count |
| Display modes | ✅ | NTSC composite (artefact colour decoded from the 1-bit dot stream), PAL composite, monochrome (white) and green phosphor, chosen in the Display pane. PAL changes the colour decoder only; timing stays at 262 lines |
| Lores colours | ✅ | Fixed 16-colour table in both composite modes; 16 luminances in monochrome and green |
| Double hi-res | ✅ | 560 dots across, auxiliary byte then main byte per 14-dot cell; colour decoded from every four dots in composite modes |
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
| MCP tools | ◐ | Generic: `model`, `run`, `step_frame`, `step`, `continue`, `registers`, `set_register`, `read_memory`, `write_memory`, `find`, `disassemble`, `breakpoint`, `delete_breakpoint`, `memory_watchpoint`, `delete_memory_watchpoint`, `trap`, `trap_delete`, `trap_log`, `trap_respond`, `key`, `type`, `load` (with `drive`), `eject`, `screenshot`, `ocr`, `symbols`, `symbols_load`. `port_in` and `port_out` decline (no I/O port space). `save` is Spectrum-only. No machine-specific tools |
| Drive count | ✅ | One or two drives on the Disk ][ controller, from **Drive count** in drive 1's options menu; saved, rebuilds the machine |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| MCP `key` combinations and `type` punctuation or capitals do not apply modifiers | All (MCP only) | low | The tools press a modifier as a separate key event, so the Apple II keyboard (which reads modifiers from each event) sees plain keys: `sym+p` gives `P`, not Ctrl-P. The `type` tool describes its symbol chords as Spectrum mappings |
| Disk bit position is approximated across pauses between reads | All with Disk ][ | low | Documented in `peripherals/disk2.ts`: each read advances at most one byte's worth of bits so framing stays exact; this is invisible to DOS and ProDOS but "only flux-level copy protection could tell the difference" |

## Not emulated

- **Double lo-res.** Lores reads main RAM only, even on the //e family with auxiliary RAM.
- **Mid-frame video changes.** The picture is rendered once per frame from the final switch state; raster tricks that change mode within a frame do not show.
- **Cassette recording.** `$C020` output is counted for the activity readout but never captured to a file.
- **Annunciators and the game-port strobe.** `$C040` and `$C058`–`$C05D` are ignored.
- **//c serial ports, mouse, and its VBL and mouse soft switches.** There is no code for them; slot 1 and 2 I/O reads float high (`$FF`).
- **//c 80/40 and keyboard-layout switches.** Drawn on the on-screen keyboard only.
- **Rockwell/WDC 65C02 bit instructions and WAI/STP.** They execute as NOPs on the CMOS models.
- **Other expansion cards.** Only the Disk ][ controller, language card, Videx Videoterm, Mockingboard and extended 80-column card exist (no mouse, clock, serial, hard-disk or CPU cards). The Mockingboard has no speech chip.
- **Other disk formats.** Only 16-sector 6-and-2 `.dsk`/`.do`/`.po` images, and no raw-nibble or copy-protected images (the codec produces the standard layout only). 13-sector, `.nib`, `.woz`, `.2mg` and hard-disk images are not accepted.
- **Analogue paddles.** Input is digital only.
- **Machine snapshots.** The snapshot service is absent.

## Faithful quirks

- **The original ][ does not autostart.** Reset drops into the Monitor; a mounted disk is booted by jumping to `$C600`.
- **//e and //c RESET needs CTRL.** The keyboard passes RESET to the CPU only with CTRL held; RAM survives a reset.
- **Language card write enable.** Writes are enabled only after two consecutive reads of an odd `$C08x` switch; a write access between them restarts the count.
- **Unfitted paddles read full scale.** With nothing in the game port every timer runs to its limit (255) and no button closes.
- **`$C019` is inverted on the //e family.** It is high while the beam is drawing.
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
| `tests/apple2.test.ts` | Registration, memory map, soft switches, cassette deck, hardware options, original ][ boot jump, language card, Videx card, Mockingboard, paddles and joystick, KEY indicator, video addressing and composite/PAL/green rendering, OCR, Disk ][ stepper, GCR stream and spin-down | Test suite |
| `tests/apple2e.test.ts` | //e MMU main/auxiliary paging, ROM and `$C300`/INTC8ROM handling, auxiliary language-card RAM, soft-switch read-back, keyboard, character set, 80-column text and double hi-res | Test suite |
| `tests/apple2-cmos.test.ts` | Enhanced //e and //c registration, 65C02 execution through the machine bus, 65C02 disassembly, MouseText, the //c's fixed internal ROM and built-in hardware | Test suite |
| `tests/apple2-disk.test.ts` | GCR/4-and-4/6-and-2 codec against the published definitions, sector skews, length tolerance, MacBinary and SIMSYSTEM headers, sector-order detection, volume number | Test suite |
| `tests/apple2-keyboard.test.ts` | ][ encoder codes against the Reference Manual table, key release tracking, REPT, RESET on each family | Test suite |
| `tests/m6502.test.ts`, `tests/m65c02.test.ts`, `tests/m6522.test.ts` | NMOS 6502 (flags, decimal, page crossings, interrupts, undocumented opcodes), 65C02 differences and the 6522 VIA, from the datasheets | Test suite |
| Real-ROM disk boots (headless): ][ and //e boot most of a 428-disk TOSEC sample; //e runs many 128K titles; Videx `PR#3` prints 80 columns | Recorded as working; not repeatable from the repo | 2026-10-18 |
| Real-ROM Enhanced //e and //c (headless): //c boots DOS 3.3, `PR#3` gives 80 columns, runs 65C02 code; 103 of 107 sampled disks behave as on the Enhanced //e | Recorded as working; not repeatable from the repo | 2026-10-18 |
