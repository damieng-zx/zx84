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
| **Accuracy** | Per-instruction Z80 at a flat 3.4 MHz with no memory contention; gate array stepped per scan line (312 lines × 218 T-states = 68,016 T-states per 50 Hz field) |
| **Status** | Boots CP/M Plus and LocoScript system discs; printer, serial and execution tracing are not implemented |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PCW 8256 (`pcw8256`) | 1985 | 256 KB (16 blocks of 16 KB) | None | 720×256 monochrome, green phosphor | Beeper | One drive (A:), 3" | Dot-matrix printer (stubbed) |
| PCW 8512 (`pcw8512`) | 1985 | 512 KB (32 blocks) | None | 720×256 monochrome, green phosphor | Beeper | Two drives (A:, B:), 3" | The only model with a second drive |
| PCW 9512 (`pcw9512`) | 1987 | 512 KB (32 blocks) | None | 720×256 monochrome, white phosphor | Beeper | One drive (A:), 3" | Daisywheel printer (stubbed); 9000-series keyboard deck |
| PCW 9256 (`pcw9256`) | 1991 | 256 KB (16 blocks) | None | 720×256 monochrome, green phosphor | Beeper | One drive (A:), 3.5" | Dot-matrix printer (stubbed); 9000-series keyboard deck; 3.5" drive sound |

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
| Gate array — roller RAM video | all | ✅ | 720×256 bitmap fetched through a 256-entry roller RAM table (port &F5 base, port &F6 start entry for scrolling, read live each scan line); 90 bytes per line taken 8 bytes apart. Port &F7 bit 6 enables the screen, bit 7 reverses it. [`asic.ts`](../../src/machines/pcw/asic.ts) |
| Gate array — 300 Hz timer | all | ✅ | Six /INT pulses per field at lines 258, 310, 50, 102, 154, 206; each pulse lasts about 100 µs (340 T-states). A 4-bit pending count, saturating at 15, is read and cleared via port &F4 (port &F8 reads it without clearing) |
| Gate array — status byte | all | ◐ | Ports &F4/&F8: count (b3–0), 32-line screen (b4, always set), uPD765A interrupt (b5), flyback (b6). Reports frame flyback only, not the per-line pulse |
| Gate array — FDC interrupt routing | all | ✅ | Port &F8 commands 2/3/4 connect the uPD765A interrupt to /NMI, /INT or neither (neither after reset) |
| Gate array — system commands | all | ✅ | Port &F8 takes a command number: 0 end bootstrap, 1 reboot, 2–4 FDC routing, 5/6 set/clear terminal count, 7/8 screen on/off, 9/10 drive motor on/off, 11/12 beep on/off. Reboot is deferred to the end of the field |
| Memory-mapped keyboard | all | ✅ | 16 bytes overlaid on &3FF0–&3FFF of physical block 3 wherever block 3 is paged in for reading; refreshed on each of the six timer lines. A pressed key sets its bit. Includes the Shift Lock LED bit, link bits and the update-heartbeat bit. [`pcw-keyboard.ts`](../../src/machines/pcw/pcw-keyboard.ts) |
| Beeper | all | ✅ | One-bit output toggled by port &F8 commands 11/12. There is no sound chip |
| uPD765A FDC + 3" / 3.5" drives | all | ✅ | Shared core [`src/cores/upd765a.ts`](../../src/cores/upd765a.ts), answering ports &00–&7F (A7 low selects the chip, A0 picks the status or data register). Terminal count is driven from port &F8 commands 5/6. Commands answer after a 16-scan-line response time so the interrupt-driven BIOS sees an interrupt edge. Drive B is connected on the 8512 only; recalibrating a missing drive fails |
| Printer ports &FC/&FD | all | ◐ | Writes are counted and discarded. &FD reads back ready with paper (&C4; &E4 on the 9512, whose daisywheel is identified by b5); &FC reads &F8 (no error). See Not emulated |
| Bootstrap | all | ◐ | The gate array's invented bootstrap code is replaced by loading the boot sector (cylinder 0, head 0, sector 1) to &F000 and entering at &F010. The sector's bytes must sum to &FF (8-bit) or the boot is refused with a status-line message |

---

## Peripherals

None. The PCW descriptor hides the tape, Microdrive, mouse, joystick, system
variables and font panes, and has no joystick, mouse or cartridge slot.

---

## Media formats

ZIP archives are unpacked and their contents routed as below. All PCW media
mounts into the disc drives; content is detected from the file, so the
extension only decides whether the file is accepted.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.dsk` | Disk | Drive A: (B: on the 8512) | ✅ | ✅ | Standard and extended DSK. Saved as `.dsk` |
| `.td0` | Disk | Drive A: (B: on the 8512) | ✅ | ✗ | Teledisk; a mounted TD0 image saves back out as `.dsk` |
| `.hfe` | Disk | Drive A: (B: on the 8512) | ✅ | ✅ | Bitstream retained; saved back as `.hfe` |
| `.scp` | Disk | Drive A: (B: on the 8512) | ✅ | ✗ | Flux image decoded to sectors; a mounted SCP image saves back out as `.dsk` |

Inserting a disc into drive A on a machine that has not booted starts the boot
(a reset with a disc already in A: boots straight into it). On one-drive models,
a mount aimed at drive B goes to drive A. The disc's write-protect state is
settable per drive. Blank DSK or HFE discs can be created from the Drives pane
(PCW/+3 single-sided 180 KB and PCW double-sided 720 KB are among the formats
offered). Mounted discs are persisted across reloads.

**Save menu exports:** PNG screenshot, `.scr` screen dump (the first 32 KB of physical RAM as the display fetch sees it), RAM `.bin` (all fitted RAM, 256 KB or 512 KB). There are no snapshots or tapes.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Flat 3.4 MHz clock | ◐ | Models the gate array's stolen memory cycles as a lower clock rather than per-access contention |
| Scan-line display | ✅ | Each of the 256 active lines is drawn after the CPU has run that line, so mid-frame roller-RAM changes take effect; a breakpoint leaves a coherent partial frame |
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
| Trace | ✗ | `trace: false` in the descriptor; `startTrace` is a no-op and `stopTrace` returns nothing |
| Screen OCR / TEXT overlay | ✅ | Cuts the screen into 90×32 cells of 8×8 pixels (walking roller RAM) and matches them against the CP/M character set in RAM (block 2, offset &3800). Reports that OCR is unavailable if that area does not look like a font, and so is meaningful for CP/M screens. The TEXT overlay blanks matched cells |
| Software library | ✗ | `library: false` |
| Memory Layout pane | ✅ | Shows read and write block per 16 KB range, &F0–&F4, roller base and whether the machine has booted; flags the block holding roller RAM and the keyboard block |
| On-screen keyboard | ✅ | 82 caps on the keyboard matrix; the 8256/8512 slab layout, or the 9512/9256 three-block layout. Caps with no host key (COPY, PASTE, EXCH, function keys) are clickable. Included in the keyboard lab presets |
| Host keyboard | ✅ | Letters, digits, punctuation, numeric pad, F2/F4/F6/F8, Escape (STOP), Caps Lock (SHIFT LOCK, latching), Control (ALT), Alt (EXTRA), Backspace (DEL←), Delete, Tab, Enter |
| MCP tools | ✅ | Generic tools: `model`, `load` (`.dsk`/`.td0`/`.hfe`/`.scp`, drive 0/A or 1/B), `eject`, `run`, `step`, `registers`, `read_memory`, `write_memory`, `disassemble`, breakpoints and watchpoints, `port_in`, `port_out`, `key`, `type`, `ocr`, `screenshot`, `fdc_log`. No PCW-specific tool. `save` (SZX), `disk_boot`, `disk_trace`, `frame_trace`, and the sector-level tools `weak`, `disk_geometry`, `track_geometry`, `sector_read` do not apply to the PCW. `trace` has no effect |

---

## Known issues

None known.

## Not emulated

- **Printer.** Writes to ports &FC/&FD are counted and discarded; nothing is printed on either the 9-pin dot-matrix (8256, 8512, 9256) or the 9512 daisywheel. Status reads report an idle, ready printer so the BIOS does not hang.
- **Memory contention.** Display cycle stealing is folded into the flat 3.4 MHz clock; there is no per-access wait state.
- **Gate array bootstrap mode.** The invented bootstrap code is not run; the boot sector is placed and entered natively.
- **Per-line flyback pulse.** Status bit 6 reports frame flyback only; software that watches for the line pulse itself sees nothing.
- **60 Hz / 28-line screen.** The status byte always reports the 50 Hz, 32-line screen.
- **Cursor and extended keyboard bits.** The key bits in &3FFB–&3FFF are unmapped (a `TODO(verify)` in the keyboard source: the reference does not enumerate them). The joystick bits of &3FF9 have no cap and no host mapping, and the joystick and mouse inputs are absent.
- **Drive mechanism limits.** Single- versus double-sided drive A (8256/8512 versus 9512/9256) is recorded per model but not enforced on mounted images.
- **Tape, snapshots, cartridges, system ROM.** The PCW has none; the corresponding services are absent.
- **Add-on ports.** Any port not decoded reads as open bus (&FF) and ignores writes; no serial interface or mouse is attached.
- **Execution tracing.** Not wired up for this machine.

## Faithful quirks

- **Unfitted RAM blocks alias.** A block number past the fitted RAM wraps (block 20 is block 4 on a 256 KB machine). CP/M Plus sizes memory by finding that wrap, so it reports the real drive M: sizes; modelling absent blocks as open bus would report an enormous RAM disc.
- **Port &F4 "reads follow writes" bits are not in address order.** Bits 7–4 apply to &C000, &0000, &8000 and &4000 respectively.
- **The FDC answers the whole of &00–&7F.** Z80 A7 is the chip select, so every port with A7 low reaches the uPD765A.
- **Port &F8 writes are command numbers, not a bit field.**
- **Timer interrupts can be lost.** The 300 Hz pulse lasts about 100 µs and is not held until acknowledged, so a tick that falls while interrupts are disabled is only counted in the port &F4 counter.
- **Writes under the keyboard overlay reach RAM.** CPU reads of &3FF0–&3FFF in a block-3 mapping return the live matrix, while writes go to the RAM underneath.
- **Terminal count arrives after the last data byte.** The BIOS asserts it after reading the final byte of each sector; the controller accepts that and still terminates the transfer normally.
- **A non-system disc is refused.** A boot sector whose 512 bytes do not sum to &FF does not execute, as on hardware.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| [`tests/pcw/asic.test.ts`](../../tests/pcw/asic.test.ts) | Roller RAM address decoding and live reads, &F6 start offset and wrap, six interrupts per field at the documented lines, 4-bit saturating counter, &F4 clears and &F8 does not, FDC routing, status byte, scan-line rendering and reverse video | Unit test |
| [`tests/pcw/memory.test.ts`](../../tests/pcw/memory.test.ts) | Reset mapping, single and split bank writes, &F4 bit order, block aliasing, physical video addressing, keyboard overlay on block 3 | Unit test |
| [`tests/pcw/machine.test.ts`](../../tests/pcw/machine.test.ts) | Registry entry with no ROM, per-model RAM/drives/printer/drive type/phosphor, port decode, system commands, FDC response time, boot-sector load at &F000/&F010, 300 Hz pulse behaviour | Unit test |
| [`tests/pcw/bootstrap.test.ts`](../../tests/pcw/bootstrap.test.ts) | Boot sector checksum and location, with no-disc, unreadable and bad-checksum reported separately | Unit test |
| [`tests/pcw/keyboard.test.ts`](../../tests/pcw/keyboard.test.ts), [`pcw-keyboard-layout.test.ts`](../../tests/pcw/pcw-keyboard-layout.test.ts) | Matrix bit positions, idle zero state, link and heartbeat bits, on-screen keyboard caps and geometry for both decks | Unit test |
| [`tests/pcw/ocr.test.ts`](../../tests/pcw/ocr.test.ts) | Font sanity check, cell recognition, TEXT overlay capability | Unit test |
| [`tests/cores/upd765a-int.test.ts`](../../tests/cores/upd765a-int.test.ts), [`upd765a-tc.test.ts`](../../tests/cores/upd765a-tc.test.ts) | uPD765A interrupt line and terminal-count behaviour the PCW depends on | Unit test |
| [`tests/emulator.test.ts`](../../tests/emulator.test.ts) | Drive A disc kept when switching within the PCW family, dropped when switching to another machine | Unit test |
| [`tests/floppy/td0.test.ts`](../../tests/floppy/td0.test.ts) | Teledisk parsing, including PCW-shaped tracks | Unit test |
| Real CP/M Plus 1.4 and LocoScript system discs, run headless | CP/M Plus reaches its banner and prompt (RAM disc reported as 112 KB on the 8256, 368 KB on the 8512); LocoScript boots and draws | 2026-09-04 |
