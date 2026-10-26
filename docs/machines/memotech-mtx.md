# Memotech MTX

Memotech's Z80 home computer family. zx84 emulates the MTX500, MTX512 and RS128
with the TMS9929A video chip, SN76489A sound, banked memory, ROM BASIC, logical
cassettes, the FDX/SDX floppy interface, the FDX 80-column display, the 512 KiB
RAM expansion and a CP/M profile.

| | |
| --- | --- |
| **Manufacturer** | Memotech |
| **Released** | From 1983 (MTX500, MTX512) |
| **CPU** | Zilog Z80A — 4 MHz |
| **zx84 kind** | `mtx` — [`src/machines/mtx/`](../../src/machines/mtx/) |
| **Model ids** | `mtx500` `mtx512` `rs128` — the MCP `model` target and `?model=` value |
| **Accuracy** | Scanline: the VDP is drawn one line at a time at 313 lines × 50 Hz (80,000 T-states per frame). No memory contention; no Accuracy setting |
| **Status** | Working — ROM BASIC, `.mtx` cassettes, FDX/SDX floppies, 80-column display and the CP/M profile are implemented; printer port and RS-232 are not |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MTX500 (`mtx500`) | 1983 | 32 KiB (two 16 KiB blocks) | 24 KiB (OS, BASIC, Assembler) | TMS9929A | SN76489A | Logical cassette; FDX floppy fitted by default | Cannot use the CP/M profile; enabling it switches to the MTX512. 544 KiB with the RAM expansion |
| MTX512 (`mtx512`) | 1983 | 64 KiB (four 16 KiB blocks) | 24 KiB (OS, BASIC, Assembler) | TMS9929A | SN76489A | Logical cassette; FDX floppy fitted by default | 576 KiB with the RAM expansion. The default CP/M target |
| RS128 (`rs128`) | | 128 KiB (eight 16 KiB blocks) | 24 KiB (OS, BASIC, Assembler) | TMS9929A | SN76489A | Logical cassette; FDX floppy fitted by default | 640 KiB with the RAM expansion |

All three models share one firmware set and one set of options. They differ
only in the amount of motherboard RAM. Two optional 8 KiB ROMs (CP/M bootstrap
and FDX Disk BASIC) sit in the switchable ROM area alongside the base firmware.

### ROM sets

| Model | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| All | UK only | `os.rom`, `basic.rom`, `assem.rom`, `boot-type07.rom`, `sdx-type07.rom` (8 KiB each) | Hosted (`roms/memotech/`) |

- The five 8 KiB images appear as five slots in the ROM pane: MTX OS, MTX BASIC, MTX ASSEM, CP/M Bootstrap and FDX Disk BASIC. Any slot can be replaced and reverted individually.
- A full concatenated firmware image dropped on any one slot is split across all five.
- The FDX Disk BASIC slot is hidden while the floppy subsystem is removed (CP/M force-fits it).
- A dropped raw ROM image of 24 KiB, 32 KiB or 40 KiB is accepted as MTX firmware and keeps the current MTX model, or selects the MTX512 otherwise. The 32 KiB layout is the older one that places Disk BASIC fourth; it is still mapped to the Disk BASIC page.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| Z80A CPU | all | ✅ | Shared core [`src/cores/z80.ts`](../../src/cores/z80.ts); 4,000,000 Hz; no contention. RETI is wired to the CTC |
| TMS9929A video | all | ✅ | Core [`src/cores/tms9918a.ts`](../../src/cores/tms9918a.ts); 16 KiB private VRAM on ports 01h (data) and 02h (control/status); 256 × 192 active area, scanline rendering, MSX palette family |
| Z80 CTC | all | ✅ | Core [`src/cores/z80-ctc.ts`](../../src/cores/z80-ctc.ts), ports 08h–0Bh. Channel 0 counts VDP interrupt edges; it is the only interrupt daisy-chain device |
| SN76489A | all | ✅ | Core [`src/cores/sn76489.ts`](../../src/cores/sn76489.ts), `mtx` variant. Written via a latch (see Faithful quirks) |
| Banked memory | all | ✅ | IOBYTE on port 00h: bits 0–3 RAM page, bits 4–6 ROM page at 0x2000, bit 7 all-RAM (CP/M) mode. 16 KiB block 0 is always common at 0xC000. Unfitted blocks read 0xFF and drop writes |
| Keyboard matrix | all | ✅ | 8 drive lines × 10 sense lines on ports 05h/06h; F1–F8 are matrix keys; country code fixed to English |
| Joystick sockets | all | ✅ | Two Atari-style sockets wired in parallel with the keyboard |
| Cassette interface | all | ◐ | Logical byte streams: LOAD/VERIFY are served to the ROM tape routine and SAVE is recorded from it; port 03h output is latched but not decoded (see Not emulated) |
| Printer port (04h) | all | ✗ | Not surfaced |
| Uncommitted PIO (07h) | all | ✗ | Not surfaced |
| DART / RS-232 | all | ✗ | Optional on the MTX500/512, standard on the RS128; not emulated |

---

## Peripherals

Fittable from the Hardware pane unless noted. Settings are remembered.

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| ROM extension card / ROM pack | ROM | all | ✅ | Always available (ROM/Carts pane or load a `.rom`). Appears as ROM page 2 (`ROM 2` in BASIC). 1–16 banks of 8 KiB; a write to 0x0000–0x1FFF latches the bank. Inserting or ejecting resets the machine; a fitted pack survives a reset |
| FDX/SDX floppy interface | Disk | all | ✅ | Hardware pane **Floppy (FDX)**, on by default. WD179x-compatible controller on ports 10h–13h plus a drive latch on 14h (drive, side, motor, density; reads READY, INTRQ, DRQ). Drives **B:** and **C:** (5.25-inch), FDX Disk BASIC ROM in page 5. Removing it ejects both disks |
| 512 KiB RAM expansion | RAM | all | ✅ | Hardware pane **512KB RAM**. 32 further 16 KiB blocks, filled with 0xE5 and kept across reset; resets the machine when toggled |
| FDX 80-column display | Video | all | ✅ | Hardware pane **80-columns**. 6845-based 80 × 24, 8 × 10 glyphs, eight colours, per-cell blink and mosaic graphics, 640 × 240 frame; ports 30h–33h and 38h–39h. Replaces the VDP picture while on |
| CP/M profile | Software | MTX512, RS128 | ✅ | Hardware pane **CP/M**. Enables the CP/M bootstrap ROM (page 4), force-fits the floppy and the 80-column display, mounts the public Type 07 system disk (`Dave07Sys.hfe`) in Drive B: when that drive is empty, and resets. The boot-sector startup command is `CONFIG B:07`; with the 512 KiB expansion fitted it also runs `SIDISC` and `CONFIG F:43`, giving a type-43 SiDisc RAM drive as F: |
| Joysticks | Input | all | ✅ | Player 1 shadows the cursor/Home keys; player 2 shadows Z/C/B/M/Space |

**Combination rules:** the CP/M profile forces the floppy and 80-column options
on (their checkboxes are disabled while CP/M is on) and needs an MTX512 or
RS128. Turning it on from an MTX500 switches the model to the MTX512. The
startup command of a disk the user mounted is never rewritten; only the hidden
system disk is patched.

---

## Media formats

ZIP archives are unpacked and only entries that match the table below are offered.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.rom` | ROM pack | ROM page 2 (cartridge slot) | ✅ | ✗ | 8 KiB to 128 KiB in whole 8 KiB banks; anything else is rejected |
| `.mtx` | Logical cassette | Tape | ✅ | ✅ | The byte stream the ROM asks for; at least the 18-byte header is required. Served instantly to `LOAD` and `VERIFY`. Save is the latest program the ROM SAVEd (Save menu), named after it |
| `.hfe` | Disk | Drive B: (default) or C: | ✅ | ✅ | HFE v1 bitstream. Saved back as `.hfe`. HFE v3 is rejected |
| `.mfloppy` / `.mfloppy-07` | Disk | Drive B: (default) or C: | ✅ | ✅ | Type 07: 80 tracks × 2 sides × 16 × 256-byte sectors (655,360 bytes). Saved as `.mfloppy` |
| `.mfloppy-03` | Disk | Drive B: (default) or C: | ✅ | ✅ | Type 03: 40 tracks × 2 sides (327,680 bytes). Saved as `.mfloppy-03` |

Disk geometry is chosen from the file size, not the extension; any size other
than the two above is refused. Disks need the floppy subsystem to be fitted.
Per-drive write protect is available. Formatting (WRITE TRACK) is supported
and re-detects the disk's geometry.

There are no snapshot or pulse-level tape formats on this machine.

**Save menu exports:** Saved tape (`.mtx`), PNG screenshot, `.scr` (a copy of the 16 KiB VDP VRAM),
RAM `.bin` (all RAM blocks, named like `mtx512-ram-576k.bin`).

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| CPU and video timing | ✅ | 313 lines per 50 Hz frame; one VDP line drawn per line of CPU time; no contention |
| Interrupts | ✅ | The VDP interrupt is a level (frame flag AND enable) sampled into CTC channel 0 as an edge; the CTC raises the Z80 interrupt with its vector |
| Fast cassette loading | ✅ | The ROM load routine at 0x0AAE is intercepted whenever an `.mtx` image is mounted (ROM mode only). It returns through 0x0AB0 (`RET Z`) with the registers the real routine leaves (HL past the block, DE 0, Z set). There is no setting to turn it off |
| Tape recording | ✅ | `SAVE` requests to the same routine (FD68 = 0) are completed instantly and copied into a logical `.mtx` stream, then leave through the routine's own epilogue at 0x0B06. The real routine cannot run here: it times its bits with CTC channel 1 counting an external clock, which is not modelled, so it waited forever. SAVE writes a 20-byte header block (0x0BA1) where LOAD asks for 18 (0x0B4F), so the stream keeps the first 18; the body requests are shared code and line up one for one. A new SAVE header starts a new recording. Offered as **Saved tape** in the Save menu; cleared by a reset |
| Border size | ✅ | None, half or full border around the 256 × 192 area |
| Palettes | ✅ | MSX colour-map options in the Display pane |
| Sound | ✅ | Mono by default, optional stereo placement of the three tone channels, anti-aliasing modes (none, box, mute, low-pass); no beeper, no tape sound |
| Drive sounds | ✅ | Shared floppy sound model, fixed 5.25-inch profile |
| Character-based typing | ✅ | Host and MCP text input is mapped to the MTX key positions and shift state, so PC punctuation lands on the right keys |
| Media persistence | ✗ | Mounted disks are not restored after a reload |
| Fast/turbo loading, loader detection | — | Not applicable: tapes are logical, not pulse-level |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger | ✅ | Breakpoints, memory and port watchpoints, stepping and Z80 disassembly. Memory-region picker: OS ROM, BASIC ROM, Assembler ROM, CP/M Bootstrap ROM, FDX Disk BASIC ROM |
| Trace | ✅ | Full (address, disassembly, registers, T-states and operand context, with tight loops folded), a port I/O tally, and ZXTrace — the shared Z80 trace engine; a trace stops capturing at 500,000 lines |
| Screen OCR / TEXT overlay | ✅ | Reads the VDP text and bitmap modes; with the 80-column display on, OCR returns its text and the TEXT overlay produces nothing |
| BASIC tools | ◐ | BASIC listing only (program at 0x4000). The system-variables, microdrive and mouse panes are hidden |
| Software library | ✗ | Not offered for this machine |
| Memory layout pane | ✅ | Shows IOBYTE, ROM page, RAM page, CP/M (all-RAM) mode and RAM size for each region |
| On-screen keyboard | ✅ | MTX layout with keypad, function keys and the shifted legends; also a keyboard-lab preset |
| Status LEDs | ✅ | Keyboard, load, disk, sound chip and TEXT |
| MCP tools | ✅ | All generic tools (`load`, `eject`, `key`, `type`, `ocr`, `screenshot`, `model`, debugger and watchpoint tools), plus `mtx80column`, `mtx512kram` and `mtxcpm` (each `on` / `off` / `status`). `mtx512kram` resets the machine; `mtxcpm on` fetches the system disk if needed, mounts it in Drive B: and resets, and refuses on an MTX500 |
| Drive count | ✅ | One or two FDX drives (B: and C:), from **Drive count** in the first drive's options menu; saved, rebuilds the machine. The FDX status latch's fixed drive-configuration bit (port 14h bit 3) does not follow the count |

---

## Known issues

None known.

## Not emulated

- **The hardware SAVE routine.** CTC channel 1's external clock is not modelled, so the ROM's bit-timed write path never runs; SAVE is always the instant logical one, and port 03h stays a latch.
- **Recording saves that bypass the ROM header.** Only streams that begin with the ROM SAVE's header request (from 0x0BA4) are recorded.
- **Pulse-level cassette.** Only the logical `.mtx` stream is supported.
- **Printer port (04h) and the uncommitted PIO (07h).** Not decoded; reads return 0xFF and writes are ignored.
- **DART / RS-232.** Not present on any model.
- **80-column terminal bell.** A read of port 30h returns 0xFF and rings nothing.
- **HFE v3** images are rejected with an error.
- **Snapshots.** The machine has no snapshot service.

## Faithful quirks

- **Sound latch.** `OUT (6)` only fills a latch; a read of port 03h strobes it into the SN76489A and returns 0x03 (the low port byte). Pothole Pete relies on that value.
- **RAM page 15 hole.** On a ROM-mode page 15 the 0x4000–0x7FFF region is open (reads 0xFF), so the firmware's memory-size probe stops at 512 KiB instead of counting motherboard RAM twice.
- **Expansion RAM survives reset.** Motherboard RAM is cleared on reset, the 512 KiB expansion is not, because CP/M uses it as a volatile RAM disc.
- **Joystick and keyboard share the matrix.** A cell stays pressed until both the key and the joystick direction are released; selecting several drive lines ANDs their sense results.
- **Absent FDX reads 0xFF.** With the floppy removed, ports 10h–14h and the Disk BASIC ROM page read 0xFF.
- **VDP interrupt is edge-counted.** While the frame flag stays set because the status register was never read, later frames make no new CTC trigger.

---

## Verification

Unit tests (104 pass in `tests/mtx/`, `tests/media/mtx-mfloppy.test.ts` and
`tests/basic/mtx-basic-parser.test.ts`, run 2026-10-18). No oracle or
real-media results are recorded.

| Reference | Result | Last checked |
| --- | --- | --- |
| `tests/mtx/mtx-memory.test.ts` — RAM sizes per model, common block, all-RAM mode, 512 KiB paging, page 15 hole, ROM-pack banking, firmware page layout | Pass | 2026-10-18 |
| `tests/mtx/mtx-machine.test.ts` — registration of all models, port decode, sound latch, VDP interrupt into CTC channel 0, RETI wiring, ROM-pack service | Pass | 2026-10-18 |
| `tests/mtx/mtx-keyboard.test.ts`, `mtx-char-input.test.ts` — matrix scanning, joystick sockets, character-intent typing | Pass | 2026-10-18 |
| `tests/mtx/mtx-tape.test.ts` — `.mtx` header, chunked `LOAD` / `VERIFY` trap, SAVE never served from the mounted image | Pass | 2026-10-26 |
| `tests/mtx/mtx-tape-save.test.ts` — SAVE recorder (18 of the 20 header bytes, body order, new header restarts, reset); with the real OS/BASIC/ASSEM ROMs in `mcp/.cache` (skipped otherwise): a BASIC program SAVEd, NEW, the recording mounted and LOADed back, RUN prints its output, and a re-SAVE is byte-identical | Pass | 2026-10-26 |
| `tests/mtx/mtx-fdx.test.ts`, `mtx-floppy.test.ts`, `mtx-hfe.test.ts` — FDX ports, drive mapping, Type 03/07 and HFE mount and save, CP/M system disk and SiDisc startup, floppy option | Pass | 2026-10-18 |
| `tests/mtx/mtx-80-column.test.ts` — 80-column ports, rendering, framebuffer switch, CP/M forcing | Pass | 2026-10-18 |
| `tests/mtx/mtx-rom-service.test.ts`, `mtx-rom-slots.test.ts` — five 8 KiB ROM slots, per-slot override, combined-image split | Pass | 2026-10-18 |
| `tests/mtx/mtx-transcribe.test.ts` — TEXT overlay driver and styled OCR | Pass | 2026-10-18 |
| `tests/media/mtx-mfloppy.test.ts`, `tests/basic/mtx-basic-parser.test.ts` — Type 03/07 sector mapping, BASIC detokenising | Pass | 2026-10-18 |
