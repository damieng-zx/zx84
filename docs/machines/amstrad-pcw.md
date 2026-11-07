# Amstrad PCW

Amstrad's Z80 word-processor-and-CP/M family: a green or white monitor, a
roller-RAM bitmap display, a memory-mapped keyboard and 3" (later 3.5") discs,
with no ROM at all. zx84 emulates the 8256, 8512, 9512 and 9256 around one gate
array model, a Z80A and a uPD765A, booting CP/M Plus or LocoScript from the disc
in drive A.

| | |
| --- | --- |
| **Manufacturer** | Amstrad |
| **Released** | 1985–1991 |
| **CPU** | Zilog Z80A — fed 4 MHz, modelled at an effective 3.4 MHz (3,400,000 Hz) |
| **zx84 kind** | `pcw` — [`src/machines/pcw/`](../../src/machines/pcw/) |
| **Model ids** | `pcw8256` `pcw8512` `pcw9512` `pcw9256` — the MCP `model` target and `?model=` value |
| **Accuracy** | Per-instruction Z80 at a flat 3.4 MHz with no memory contention; gate array stepped per scan line (312 lines × 218 T-states = 68,016 T-states per 50 Hz field, or 260 lines = 56,680 with the 60 Hz link) |
| **Status** | Boots CP/M Plus and LocoScript system discs; the printers are logged rather than emulated and there is no serial interface |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PCW 8256 (`pcw8256`) | 1985 | 256 KB (16 blocks of 16 KB) | None | 720×256 monochrome, green phosphor | Beeper | One single-sided drive (A:), 3" | Dot-matrix printer (logged) |
| PCW 8512 (`pcw8512`) | 1985 | 512 KB (32 blocks) | None | 720×256 monochrome, green phosphor | Beeper | Single-sided A:, double-sided B:, 3" | The only model with a second drive |
| PCW 9512 (`pcw9512`) | 1987 | 512 KB (32 blocks) | None | 720×256 monochrome, white phosphor | Beeper | One double-sided drive (A:), 3" | Daisywheel printer (logged); 9000-series keyboard deck |
| PCW 9256 (`pcw9256`) | 1991 | 256 KB (16 blocks) | None | 720×256 monochrome, green phosphor | Beeper | One double-sided drive (A:), 3.5" | Dot-matrix printer (logged); 9000-series keyboard deck; 3.5" drive sound |

The frame buffer is 768×288 (720×256 active plus a 24-pixel left/right and
16-pixel top/bottom unlit border), presented at half width as a 4:3 picture.
Switching between PCW models keeps the disc in drive A.

### ROM sets

None. A PCW contains no ROM: the descriptor reports no ROM pages, hides the
system ROM slot in the ROM pane, and fetches nothing at startup. The machine
boots from a system disc in drive A (CP/M Plus, LocoScript). No boot disc is
shipped or hosted (`bootDisk: false`); load your own.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| Z80A CPU | all | ✅ | Shared core [`src/cores/`](../../src/cores/); interrupt mode 1; /NMI edge-triggered, /INT level-sensitive |
| Gate array — paged memory | all | ✅ | Ports &F0–&F3 map four 16 KB blocks; bit 7 set = one block for read and write, clear = separate write (b0–2) and read (b4–6) blocks; port &F4 forces reads to follow writes per block. Reset maps blocks 0–3 in order. Block numbers past the fitted RAM wrap onto fitted blocks. [`pcw-memory.ts`](../../src/machines/pcw/pcw-memory.ts) |
| Gate array — roller RAM video | all | ✅ | 720×256 bitmap (the first 200 lines only with the 60 Hz link) fetched through a 256-entry roller RAM table (port &F5 base, port &F6 start entry for scrolling, read live each scan line); 90 bytes per line taken 8 bytes apart. Port &F7 bit 6 enables the screen, bit 7 reverses it. [`asic.ts`](../../src/machines/pcw/asic.ts) |
| Gate array — 300 Hz timer | all | ✅ | A tick every 52 lines (3.328 ms) at either frame rate, counting lines from the first displayed one: lines 12, 64, 116, 168, 220, 272 at 50 Hz and the first five at 60 Hz. Each tick pulses /INT for about 100 µs (340 T-states). A 4-bit pending count, saturating at 15, is read and cleared via port &F4 (port &F8 reads it without clearing). The count is synchronised by two opcode fetches: a tick latched by the M1 of the instruction that reads &F4 is lost, as Amstrad's spec says |
| Gate array — status byte | all | ✅ | Ports &F4/&F8: count (b3–0), 50/60 Hz option (b4: set at 50 Hz), uPD765A interrupt (b5), frame flyback (b6: 26 lines, 1,664 µs, ending 16 lines before the first displayed line — lines 270–295 at 50 Hz, 218–243 at 60 Hz). b6 is the frame signal alone: Amstrad's spec names no per-line component |
| Gate array — 50/60 Hz link | all | ✅ | **60Hz (25-line screen)** in the Hardware pane (`pcw-60hz`, rebuilds the machine) fits the motherboard link: a 260-line, 56,680 T-state field showing the first 200 lines (90×25 characters), status b4 clear, flyback and timer lines moved as above. The tick period stays 52 lines. CP/M Plus reads b4 and lays out a 25-row screen. OCR reads the 90×25 grid |
| Gate array — FDC interrupt routing | all | ✅ | Port &F8 commands 2/3/4 connect the uPD765A interrupt to /NMI, /INT or neither (neither after reset) |
| Gate array — system commands | all | ✅ | Port &F8 takes a command number: 0 end bootstrap, 1 reboot, 2–4 FDC routing, 5/6 set/clear terminal count, 7/8 screen on/off, 9/10 drive motor on/off, 11/12 beep on/off. Reboot is deferred to the end of the field |
| Memory-mapped keyboard | all | ✅ | 16 bytes overlaid on &3FF0–&3FFF of physical block 3 wherever block 3 is paged in for reading; refreshed on each timer line. A pressed key sets its bit. &3FFC–&3FFF carry the keyboard controller's joystick-shaped key groups (pad cursor diamond, inverted T round f1, the letter-key directions), the Shift Lock LED bit, the link bits and the update-heartbeat bit. [`pcw-keyboard.ts`](../../src/machines/pcw/pcw-keyboard.ts) |
| Beeper | all | ✅ | One-bit output toggled by port &F8 commands 11/12. There is no sound chip |
| uPD765A FDC + 3" / 3.5" drives | all | ✅ | Shared core [`src/cores/upd765a.ts`](../../src/cores/upd765a.ts), answering ports &00–&7F (A7 low selects the chip, A0 picks the status or data register). Terminal count is driven from port &F8 commands 5/6. Commands answer after a 16-scan-line response time so the interrupt-driven BIOS sees an interrupt edge. Drive B is connected on the 8512 only; recalibrating a missing drive fails. Drive A is single-sided on the 8256 and 8512 (see Faithful quirks) |
| Printer ports &FC/&FD | all | ◐ | Every byte written is logged and can be saved as a decoded text listing (see Save menu exports); nothing is printed. &FD reads back ready with paper (&C4; &E4 on the 9512, whose daisywheel is identified by b5); &FC reads &F8 (no error). The 9512's &00FC/&01FC data and command ports are told apart by A8. The dot-matrix listing decodes the controller commands of John Elliott's hardware guide §6.1.2 (initialise, reset, head moves, line feeds, print passes with their 9-pin columns drawn as pin pictures) and the 9512's §6.2 daisywheel commands. Which BIOS bytes mean which characters is not decoded: dot-matrix characters are built from pin columns by the BIOS and daisywheel ones are wheel petal numbers |
| Bootstrap | all | ◐ | The gate array's invented bootstrap code is replaced by loading the boot sector (cylinder 0, head 0, sector 1) to &F000 and entering at &F010. The sector's bytes must sum to &FF (8-bit) or the boot is refused with a status-line message |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Joystick interface | input | all | ✅ | One add-on interface, chosen in the Joystick pane (one player, one fire button). Kempston at &9F (active high: b4 fire, b3 down, b2 up, b1 left, b0 right); Spectravideo at &E0 (active high: b4 right, b3 up, b2 left, b1 fire, b0 down, b7 0); Cascade at &E0 (active low: b7 fire, b4 up, b2 down, b1 right, b0 left). Port layouts from John Elliott's PCW hardware guide §12. None fitted: both ports read &FF |

The PCW descriptor hides the tape, Microdrive, mouse, system variables and font
panes, and has no mouse or cartridge slot.

---

## Media formats

ZIP archives are unpacked and their contents routed as below. All PCW media
except zx84's own snapshot mounts into the disc drives; content is detected
from the file, so the extension only decides whether the file is accepted.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.dsk` | Disk | Drive A: (B: on the 8512) | ✅ | ✅ | Standard and extended DSK. Saved as `.dsk` |
| `.td0` | Disk | Drive A: (B: on the 8512) | ✅ | ✗ | Teledisk; a mounted TD0 image saves back out as `.dsk` |
| `.hfe` | Disk | Drive A: (B: on the 8512) | ✅ | ✅ | Bitstream retained; saved back as `.hfe` |
| `.scp` | Disk | Drive A: (B: on the 8512) | ✅ | ✗ | Flux image decoded to sectors; a mounted SCP image saves back out as `.dsk` |
| `.pcwstate` | Snapshot | Machine | ✅ | ✅ | zx84's own exact save state, discs included (see below) |

Inserting a disc into drive A on a machine that has not booted starts the boot
(a reset with a disc already in A: boots straight into it). On one-drive models,
a mount aimed at drive B goes to drive A. The disc's write-protect state is
settable per drive. Blank DSK or HFE discs can be created from the Drives pane
(PCW/+3 single-sided 180 KB and PCW double-sided 720 KB are among the formats
offered). Mounted discs are persisted across reloads.

**Snapshots.** `.pcwstate` is zx84's native save state, in the same container
as the Atari's `.a8state` (magic `ZXPC`, a CRC-32 and length checked before the
machine is touched, deflated when saved): the Z80 with its hidden MEMPTR/Q
latches and interrupt delays, all fitted RAM and the &F0-&F4 paging, the gate
array (roller RAM base and offset, video control, the 300 Hz pulse and its
counter and any tick part-way into it, FDC interrupt routing), the keyboard's SHIFT LOCK and update-toggle
latches, the beeper, the beam's frame grid, and the uPD765A down to the byte a
sector transfer has reached (terminal count and INT response timing included).
A saved file carries the mounted discs exactly as the controller sees them
(in-session writes, weak sectors and HFE bitstreams included) and their names;
loading it replaces the discs in the drives. The header records the model (a
state from another PCW asks to switch to it) and the fitted drive count, which
must match the Drives pane or the state is refused, as must the frame rate
(the 60 Hz link is part of the CONF section; a state without one is 50 Hz). The
printer log travels in its own `PRN ` section (older states have none). There is
no ROM to check.
A state is taken between frames (a frame a debugger stop left open is run to
its end first). The same state, without the discs, backs browser-refresh
resume. Held keys and the write-protect switches are not part of the state.

**Save menu exports:** Snapshot `.pcwstate`, PNG screenshot, `.scr` screen dump (the first 32 KB of physical RAM as the display fetch sees it), RAM `.bin` (all fitted RAM, 256 KB or 512 KB), and **Printer output (.txt)** — the decoded log of what the BIOS sent the printer controller (nothing is saved, and the status line says so, until something has been printed). There are no tapes.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Flat 3.4 MHz clock | ◐ | Models the gate array's stolen memory cycles as a lower clock rather than per-access contention (see Not emulated) |
| Scan-line display | ✅ | Each of the 256 active lines (200 at 60 Hz) is drawn after the CPU has run that line, so mid-frame roller-RAM changes take effect; a breakpoint leaves a coherent partial frame |
| Phosphor colour | ✅ | Green by default, white on the 9512; `pcw-phosphor` setting accepts `green` or `white` |
| Border size | ✅ | None / small / normal crop of the unlit border |
| Reverse video and screen blanking | ✅ | Port &F7 bits plus port &F8 commands 7/8; the border does not invert |
| Drive sounds | ✅ | Shared floppy sound model; 3" profile on 8256, 8512 and 9512, 3.5" on the 9256. Drive LED shows idle, executing or writing |
| Status-bar LEDs | ✅ | `kbd`, `dsk`, `beep`, `text` |
| Media persistence | ✅ | Mounted discs come back after a reload |
| Speed multiplier | ✅ | Audio mixing is skipped while the multiplier is not 1× |
| Boot / reset | ✅ | Reset with a disc in A: reboots from it; `OUT (&F8),1` triggers the same reset |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | Shared Z80 debug service; memory and port watchpoints are checked in the PCW's access hooks |
| Trace | ✅ | Full (address, disassembly, registers, T-states and operand context, with tight loops folded), a port I/O tally, and ZXTrace — the shared Z80 trace engine; a trace stops capturing at 500,000 lines |
| Screen OCR / TEXT overlay | ✅ | Cuts the screen into 90×32 cells (90×25 at 60 Hz) of 8×8 pixels (walking roller RAM) and matches them against the CP/M character set in RAM (block 2, offset &3800). Reports that OCR is unavailable if that area does not look like a font, and so is meaningful for CP/M screens. The TEXT overlay blanks matched cells |
| Software library | ✗ | `library: false` |
| Memory Layout pane | ✅ | Shows read and write block per 16 KB range, &F0–&F4, roller base and whether the machine has booted; flags the block holding roller RAM and the keyboard block |
| On-screen keyboard | ✅ | 82 caps on the keyboard matrix; the 8256/8512 slab layout, or the 9512/9256 three-block layout. Every cap but `< §` has a host key; all are clickable. Included in the keyboard lab presets |
| Host keyboard | ✅ | Letters, digits, punctuation, numeric pad, Escape (STOP), Caps Lock (SHIFT LOCK, latching), Control (ALT), Alt (EXTRA), Backspace (DEL←), Delete, Tab, Enter. **Cursor keys** press the pad caps that carry the arrows (↑ pad 5, ← pad 1, → pad 3, ↓ pad .). **F1–F8** press the four function caps (f1/f2, f3/f4, f5/f6, f7/f8) with SHIFT added for the even-numbered key. **Home** PTR, **End** EXIT, **F9** CUT, **F10** COPY, **Insert** PASTE, **Pause** CAN, **Page Up/Down** the boxed [+] and [−], the host `<`/`>` key (`IntlBackslash`) the `< §` cap |
| MCP tools | ✅ | Generic tools: `model`, `load` (`.dsk`/`.td0`/`.hfe`/`.scp`, drive 0/A or 1/B), `eject`, `run`, `step`, `registers`, `read_memory`, `write_memory`, `disassemble`, breakpoints and watchpoints, `port_in`, `port_out`, `key`, `type`, `ocr`, `screenshot`, `fdc_log`. No PCW-specific tool. `save` (SZX), `disk_boot`, `disk_trace`, `frame_trace`, and the sector-level tools `weak`, `disk_geometry`, `track_geometry`, `sector_read` do not apply to the PCW. `trace` works in all three modes |
| Drive count | ✅ | Up to the model's own drives (one on the 8256, 9256 and 9512; two on the 8512). **Drive count** in drive A's options menu can lower an 8512 to one; saved, rebuilds the machine |
| Hardware pane | ✅ | **60Hz (25-line screen)** — the 50/60 Hz motherboard link (rebuilds the machine) |

---

## Known issues

None known.

## Not emulated

- **Printing.** The printer controllers are logged, not emulated: nothing is printed, and the listing decodes controller commands rather than recovering the document's text (dot-matrix characters are pin columns built by the BIOS; daisywheel ones are petal numbers for whatever wheel is fitted). The printer always reports idle and ready with paper, so the BIOS handshake never waits. The 9512's PAR (Centronics) port bytes are echoed in the listing but the port has no handshake. Not checked end to end: CP/M Plus's own printer output (`PIP LST:=…`) produced no printer traffic on the boot disc tried, so only the BIOS's initialisation sequence (`00 00 A4 01 A9 C0`, matching the guide's example) is confirmed from a real disc; the print-pass decoding is confirmed against the guide's documented formats by unit tests.
- **Memory contention.** Display cycle stealing is folded into the flat 3.4 MHz clock; there is no per-access wait state. Amstrad's spec says only that /MREQ cycles are stretched during VDU accesses to screen memory (IORQ cycles are not), and the hardware references give no pattern precise enough to model — whether every access is stretched or only collisions with a display fetch, whether flyback lines are exempt, which blocks — so a per-access model would be invented.
- **Gate array bootstrap mode.** The invented bootstrap code is not run; the boot sector is placed and entered natively.
- **Keyboard joysticks and mice.** The keyboard joystick bits (J1 in &3FF9, J2 in &3FFB) stay idle: no PCW keyboard has a socket for them (PCW hardware guide §10.3), so a host joystick goes to an add-on interface instead (see Peripherals). The LK2 link (W/A/D/X diamond in &3FFC, and the shifted &3FFD b7) and the KeyMouse, which reuses &3FFB–&3FFE, are not modelled. There is no mouse.
- **Tape, cartridges, system ROM.** The PCW has none; the corresponding services are absent.
- **Other emulators' snapshots.** Only zx84's own `.pcwstate` is loaded or saved; no community PCW snapshot format is read.
- **Add-on ports.** Any port not decoded reads as open bus (&FF) and ignores writes; no serial interface or mouse is attached. The DKTronics joystick (a port of the DKTronics sound board's AY) is not offered, as that board is not emulated.
- **FDC /NMI self-disconnect.** Amstrad's spec says command 2 routes the FDC to /NMI "until the first non-maskable interrupt occurs"; the route here stays until the BIOS changes it.

## Faithful quirks

- **Unfitted RAM blocks alias.** A block number past the fitted RAM wraps (block 20 is block 4 on a 256 KB machine). CP/M Plus sizes memory by finding that wrap, so it reports the real drive M: sizes; modelling absent blocks as open bus would report an enormous RAM disc.
- **Port &F4 "reads follow writes" bits are not in address order.** Bits 7–4 apply to &C000, &0000, &8000 and &4000 respectively.
- **The FDC answers the whole of &00–&7F.** Z80 A7 is the chip select, so every port with A7 low reaches the uPD765A.
- **Port &F8 writes are command numbers, not a bit field.**
- **Timer interrupts can be lost.** The 300 Hz pulse lasts about 100 µs and is not held until acknowledged, so a tick that falls while interrupts are disabled is only counted in the port &F4 counter. A tick latched by the opcode fetch of the very instruction that reads &F4 is not counted at all.
- **Drive A is single-sided on the 8256 and 8512.** The one-headed mechanism has nothing on its head-select line, so a double-sided image mounted there is read as side 0 whichever head a command names: Read ID on head 1 finds side 0's IDs, and a transfer asking for H=1 ends with No Data. The status line warns when such a disc is inserted. A flippy disc (two single-sided sides in one image) is unaffected and still turns over. Drive B of the 8512 and drive A of the 9512 and 9256 have both heads.
- **The 60 Hz frame is 260 lines.** A 52-line timer period that holds across the frame boundary needs a whole number of periods: 6 × 52 = 312 lines (50.08 Hz) and 5 × 52 = 260 (60.10 Hz).
- **Writes under the keyboard overlay reach RAM.** CPU reads of &3FF0–&3FFF in a block-3 mapping return the live matrix, while writes go to the RAM underneath.
- **Terminal count arrives after the last data byte.** The BIOS asserts it after reading the final byte of each sector; the controller accepts that and still terminates the transfer normally.
- **A non-system disc is refused.** A boot sector whose 512 bytes do not sum to &FF does not execute, as on hardware.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| [`tests/pcw/asic.test.ts`](../../tests/pcw/asic.test.ts) | Roller RAM address decoding and live reads, &F6 start offset and wrap, timer lines at 50 and 60 Hz derived from Amstrad's spec (2 lines into a 26-line flyback that ends 16 lines before the picture, every 52), 4-bit saturating counter and its two-fetch synchronisation, &F4 clears and &F8 does not, FDC routing, flyback lines and b4 at both rates, 200-line display at 60 Hz, scan-line rendering and reverse video | Unit test |
| [`tests/pcw/accuracy.test.ts`](../../tests/pcw/accuracy.test.ts) | The 60 Hz link end to end through port &F8 (flyback lines, timer lines, frame length), per-model drive sidedness through the FDC (Read ID and Read Data on head 1), and the printer log decoded against the hardware guide's command formats (initialisation, passes, pin pictures, line feeds, the 9512's three addresses) | Unit test |
| [`tests/pcw/snapshot.test.ts`](../../tests/pcw/snapshot.test.ts) | Exact resume with an FDC transfer in flight (8512, 8256, and a 60 Hz machine), the disc and printer log carried, a damaged or mismatched-drives or mismatched-frame-rate state refused untouched | Unit test |
| [`tests/pcw/memory.test.ts`](../../tests/pcw/memory.test.ts) | Reset mapping, single and split bank writes, &F4 bit order, block aliasing, physical video addressing, keyboard overlay on block 3 | Unit test |
| [`tests/pcw/machine.test.ts`](../../tests/pcw/machine.test.ts) | Registry entry with no ROM, per-model RAM/drives/printer/drive type/phosphor, port decode, system commands, FDC response time, boot-sector load at &F000/&F010, 300 Hz pulse behaviour | Unit test |
| [`tests/pcw/bootstrap.test.ts`](../../tests/pcw/bootstrap.test.ts) | Boot sector checksum and location, with no-disc, unreadable and bad-checksum reported separately | Unit test |
| [`tests/pcw/keyboard.test.ts`](../../tests/pcw/keyboard.test.ts), [`pcw-keyboard-layout.test.ts`](../../tests/pcw/pcw-keyboard-layout.test.ts) | Matrix bit positions, idle zero state, link and heartbeat bits, the &3FFC–&3FFF joystick-shaped groups as the hardware guide lists them, host mapping of the cursor keys, f1–f8 with SHIFT and the editing caps, shared-cap release, on-screen keyboard caps and geometry for both decks | Unit test |
| [`tests/pcw/pcw-joystick.test.ts`](../../tests/pcw/pcw-joystick.test.ts) | Kempston, Spectravideo and Cascade port bit layouts from the PCW hardware guide; none fitted floats high; keyboard-matrix joystick bits untouched | Unit test |
| [`tests/pcw/ocr.test.ts`](../../tests/pcw/ocr.test.ts) | Font sanity check, cell recognition, TEXT overlay capability | Unit test |
| [`tests/cores/upd765a-int.test.ts`](../../tests/cores/upd765a-int.test.ts), [`upd765a-tc.test.ts`](../../tests/cores/upd765a-tc.test.ts) | uPD765A interrupt line and terminal-count behaviour the PCW depends on | Unit test |
| [`tests/emulator.test.ts`](../../tests/emulator.test.ts) | Drive A disc kept when switching within the PCW family, dropped when switching to another machine | Unit test |
| [`tests/floppy/td0.test.ts`](../../tests/floppy/td0.test.ts) | Teledisk parsing, including PCW-shaped tracks | Unit test |
| Real CP/M Plus 1.4 and LocoScript system discs, run headless | CP/M Plus reaches its banner and prompt (RAM disc reported as 112 KB on the 8256 and 9256, 368 KB on the 8512 and 9512) on all four models and at 60 Hz, where its status line moves up to the 25-row screen; LocoScript boots and draws at 50 and 60 Hz. Keys typed through the host keyboard into CP/M's own key tables (`DIR`, `PIP`, `TYPE`) are received correctly | 2026-10-31 |
