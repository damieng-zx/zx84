# Amstrad CPC

Amstrad's Z80 home computer line: the cassette-based 464, the disk-equipped 664
and 6128, and the 1990 "Plus" generation (6128 Plus and the GX4000 console)
built around the Amstrad ASIC. zx84 emulates all five, with the discrete Gate
Array and the Plus ASIC modelled separately, the uPD765A floppy controller
shared with the Spectrum +3, and a small set of period add-ons.

| | |
| --- | --- |
| **Manufacturer** | Amstrad |
| **Released** | 1984–1990 |
| **CPU** | Zilog Z80A — 4 MHz, with every bus cycle stretched onto the Gate Array's 1 µs grid |
| **zx84 kind** | `cpc` — [`src/machines/cpc/`](../../src/machines/cpc/) |
| **Model ids** | `cpc464` `cpc664` `cpc6128` `cpc6128plus` `gx4000` — the MCP `model` target and `?model=` value (URL matching is case-insensitive; no id contains a `+`, so there is no spelling quirk) |
| **Accuracy** | Per-scanline raster driven by the CRTC's programmed registers; Z80 memory and I/O cycles aligned to the Gate Array `/WAIT` grid. No accuracy selector (`ui.accuracy` is `false`) |
| **Status** | Working — all five models boot from firmware ROM or cartridge; Plus ASIC sprites, soft scroll, split screen, raster interrupt and DMA sound are implemented |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CPC 464 (`cpc464`) | 1984 | 64 KB | OS + BASIC 1.0 | Gate Array + CRTC 6845 (type 0) | AY-3-8912 | Cassette | No disk controller; no RAM banking (the bank command is ignored) |
| CPC 664 (`cpc664`) | 1985 | 64 KB | OS + BASIC 1.1 + AMSDOS | Gate Array + CRTC 6845 (type 0) | AY-3-8912 | 3" floppy (uPD765A) + cassette | No RAM banking |
| CPC 6128 (`cpc6128`) | 1985 | 128 KB (8 × 16 KB banks) | OS + BASIC 1.1 + AMSDOS | Gate Array + CRTC 6845 (type 0) | AY-3-8912 | 3" floppy (uPD765A) + cassette | Eight bank configurations plus 64 KB block bits in the Gate Array RAM command |
| CPC 6128 Plus (`cpc6128plus`) | 1990 | 128 KB (as configured) | None on board — boots from a cartridge | Amstrad ASIC (integrated type 4 CRTC) | AY-3-8912 + ASIC DMA sound | Cartridge + 3" floppy + cassette | Plus features hidden until software unlocks the ASIC |
| GX4000 (`gx4000`) | 1990 | 128 KB (as configured) | None on board — boots from a cartridge | Amstrad ASIC (integrated type 4 CRTC) | AY-3-8912 + ASIC DMA sound | Cartridge only | No disk controller and no cassette deck; no tape pane, no drives pane, no on-screen keyboard |

### ROM sets

The ROM host serves every set below; the system ROM can be replaced from the ROM
pane (one slot, labelled "ROM"). On the non-Plus models the slot takes a
concatenated image: 32 KB is OS + BASIC, 48 KB adds AMSDOS; anything under 32 KB
is rejected. A non-UK locale falls back to the UK set when none exists for it.

| Model | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| 464 | UK | OS `os-464.rom`, BASIC 1.0 `basic-1-0.rom` | hosted |
| 464 | Spanish (`es`) | `os-464-es.rom`, `basic-1-0-es.rom` | hosted |
| 464 | French (`fr`) | `os-464-fr.rom`, `basic-1-0-fr.rom` | hosted |
| 664 | UK | `os-664.rom`, `basic-1-1-664.rom`, `amsdos.rom` | hosted |
| 6128 | UK | `os-6128.rom`, `basic-1-1-6128.rom`, `amsdos.rom` | hosted |
| 6128 | French (`fr`) | `os-6128-fr.rom`, `basic-1-1-6128-fr.rom`, `amsdos-fr.rom` | hosted |
| 6128 Plus, GX4000 | UK | `plus-system.cpr`: firmware (OS, BASIC 1.1, AMSDOS) on cartridge pages 0–3, the bundled Burnin' Rubber game on pages 4–7 | hosted; hidden-mounted when the cartridge slot is empty |

Upper ROM 0 is BASIC and upper ROM 7 is AMSDOS on the non-Plus models. On the
Plus the ROM-select byte is translated: logical 0 selects cartridge page 1,
logical 7 selects page 3, and a byte with bit 7 set addresses a physical page
directly. A selected upper ROM that does not exist falls back to BASIC (upper ROM
0); when that is absent too (a system cartridge was loaded without it) the bus
reads 0xFF.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| Z80A CPU | all | ✅ | Shared core [`src/cores/`](../../src/cores/). Memory cycles, I/O cycles and interrupt acknowledge each wait for their phase of the 1 µs grid ([`wait-states.ts`](../../src/machines/cpc/wait-states.ts)); internal cycles are never stretched |
| CRTC 6845 | all | ✅ | [`src/cores/crtc-6845.ts`](../../src/cores/crtc-6845.ts). Per-scanline sequencing from R0–R9, R12/R13; frame length follows the programmed registers (nominal 64 chars × 312 lines = 79,872 T-states). Models use type 0 (non-Plus) or type 4 (Plus); the core also implements types 1–3 but no model selects them |
| Gate Array (40010 style) | 464, 664, 6128 | ✅ | [`gate-array.ts`](../../src/machines/cpc/gate-array.ts). 16 pens + border from the 27-colour hardware palette; screen modes 0, 1, 2 and the undocumented mode 3 (160×200, four colours); mode latched at HSYNC; lower/upper ROM enable; RAM bank command; 52-HSYNC interrupt counter with VSYNC re-sync and bit-5 clear on acknowledge |
| Amstrad ASIC | 6128 Plus, GX4000 | ✅ | [`asic.ts`](../../src/machines/cpc/asic.ts). Superset of the Gate Array; behaves identically to it while locked. See the ASIC rows below |
| ASIC lock sequence | 6128 Plus, GX4000 | ✅ | 16-byte key written to the CRTC register-select port (&BC00), then 0xEE unlocks; any other 17th byte locks. Reset re-locks |
| ASIC 12-bit palette | 6128 Plus, GX4000 | ✅ | 32 entries (16 pens, border, 15 sprite colours), 4 bits per channel. Classic pen/border colour writes are mirrored into it whether locked or not |
| ASIC hardware sprites | 6128 Plus, GX4000 | ✅ | 16 sprites of 16×16 pixels, magnification ×1/×2/×4 per axis (field 0 hides), pen 0 transparent, lower sprite number wins, 10-bit X / 9-bit Y signed position |
| ASIC soft scroll and split screen | 6128 Plus, GX4000 | ◐ | Vertical scroll 0–7 lines, horizontal 0–15 pixels, border extend, split-screen address and scanline. Coarse horizontal backstep is not implemented (see Known issues) |
| ASIC programmable raster interrupt | 6128 Plus, GX4000 | ✅ | Fires at the programmed scanline; the 52-line flyback is suppressed while armed; IM 2 vector byte with priority raster > DMA 2 > DMA 1 > DMA 0 |
| ASIC DMA sound | 6128 Plus, GX4000 | ✅ | Three channels, one instruction per HSYNC from base 64 KB RAM: LOAD (PSG register), PAUSE (scaled by the channel prescaler), REPEAT, LOOP, INT, STOP. Drives the AY-3-8912 directly |
| ASIC RMR2 banking | 6128 Plus, GX4000 | ✅ | `%101xxxxx` on the Gate Array port while unlocked: selects which of the low eight cartridge pages backs the lower ROM, where it overlays (&0000, &4000 or &8000), and pages the 16 KB ASIC register window into &4000–&7FFF |
| ASIC analogue inputs | 6128 Plus, GX4000 | ✅ | &6808–&680F in the register window, read-only, 6 bits. ADC0/ADC1 (&6808/&6809) are joystick 1 X/Y, ADC2/ADC3 joystick 2; &00 is left / up, &3F right / down, a centred stick &20. ADC4 and ADC6 read &3F, ADC5 and ADC7 &00 (tied to +5V and ground on a real Plus). The analogue stick's buttons are the digital port's fire buttons |
| ASIC ghost writes | 6128 Plus, GX4000 | ✅ | An `IN` from the Gate Array or CRTC write ports writes the floating bus value (0xFF) to the register, as on the real ASIC |
| Intel 8255 PPI | all | ✅ | Port A to the AY data bus; Port B returns VSYNC, manufacturer code 7 (Amstrad), 50 Hz flag, expansion/printer lines pulled high, and the cassette read bit; Port C carries the keyboard line, AY BDIR/BC1, the cassette motor bit and the cassette write-data bit |
| AY-3-8912 | all | ✅ | Shared core, 1 MHz clock, stereo placement ABC by default; stereo, ultrasonic filter and DC-block controls in the Sound pane. No beeper |
| Keyboard matrix | all | ✅ | Ten lines read through the AY's I/O port A, active low. Host keys map by physical position (US layout); the UK ISO key left of Z gives `@`/`|`; the numeric keypad gives f0–f9 |
| Cassette interface | 464, 664, 6128, 6128 Plus | ✅ | Pulse-level playback, and recording of what the firmware (or any saver) writes to the cassette. Absent on the GX4000 |
| uPD765A FDC + 3" drives | 664, 6128, 6128 Plus | ✅ | Shared core [`src/cores/upd765a.ts`](../../src/cores/upd765a.ts), drives A: and B: on ports &FA7E / &FB7E / &FB7F. Weak-sector copies, per-drive write-protect, drive B force-ready, flippy-disk side flip |
| Memory banking | 6128, 6128 Plus, GX4000 | ✅ | Eight standard RAM configurations; ROM overlays on RAM with writes always falling through to RAM; video fetch always reads the base 64 KB (banks 0–3) |
| Cartridge port | 6128 Plus, GX4000 | ✅ | Up to 32 × 16 KB pages from a `.cpr` image; inserting or ejecting power-cycles the machine |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Joystick (two ports) | input | all | ✅ | Wired into the keyboard matrix: player 1 on line 9, player 2 on line 6. The emulator's primary fire button drives CPC Fire 2 (the main button on a one-button stick) and its secondary button drives Fire 1. Physical gamepads and the touch D-pad. On a 6128 Plus or GX4000 the same sticks also drive the ASIC's analogue inputs: keys at full deflection, a gamepad's analogue stick proportionally (and the digital port past half travel) |
| Kempston mouse | input | all | ✅ | Ports &FBEE (X), &FBEF (Y), &FAEF (buttons, active low); Y counts upward |
| AMX mouse | input | all | ✅ | Presented on keyboard line 9 as one-mickey pulses retired on line deselect; left/right/middle buttons map to Fire 2/Fire 1/Fire 3 |
| Multiface Two | ROM + RAM / NMI | all | ✅ | 8 KB ROM + 8 KB RAM overlaid on &0000–&3FFF. `OUT &FEE8` pages in, `OUT &FEEA` pages out; the red STOP button (Hardware pane) pages in and raises an NMI to &0066. Records writes to the Gate Array, CRTC, ROM-select and PPI control ports into its RAM so the toolkit's Return restores the machine. Can be enabled and disabled without rebuilding the machine. The code does not restrict it by model |
| ParaDOS | ROM (AMSDOS replacement) | 664, 6128, 6128 Plus | ◐ | Hardware-pane toggle shown on every disk-capable model; loads `parados.rom` into upper ROM 7 after reset. Toggling rebuilds the machine |
| Cartridge | ROM | 6128 Plus, GX4000 | ✅ | `.cpr` image in the cartridge slot; a user cartridge supersedes the hidden firmware cartridge, ejecting restores it |
| Cassette deck | tape | 464, 664, 6128, 6128 Plus | ✅ | See Media formats and Emulation features |
| 3" disk drives A:/B: | disk | 664, 6128, 6128 Plus | ✅ | Hardware pane exposes write-protect per drive and a force-ready override for drive B |

**Combination rules:** the Kempston and AMX mice are mutually exclusive (one mode
is active at a time), and the AMX mouse shares keyboard line 9 with player 1's
joystick. ParaDOS and AMSDOS both occupy upper ROM 7, so enabling
ParaDOS replaces AMSDOS. The Multiface Two overlays slot 0 and wins over the
lower ROM while paged in. A cartridge slot exists only on the Plus models; the
464, 664 and 6128 have none. A DDI-1 disk interface for the 464 is not modelled.

---

## Media formats

ZIP archives are refused on this machine (`zipPolicy: none`); load the contained
file directly. Persistence across reloads covers tapes and Plus cartridges;
disks and snapshots are session-only (`persistMedia: false`).

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.sna` | Snapshot | Machine | ✅ | ✅ | v1, v2 and v3 load (flat dump or `MEMn` chunks, RLE supported); save writes v2 (flat) or v3 (RLE). The snapshot's CPC-type byte selects the model and the machine rebuilds as that model first. Plus snapshots carry an ASIC chunk (own format) and load the standard `CPC+` chunk |
| `.cdt` | Tape | Tape deck | ✅ | ✅ | CDT/TZX container; timings rescaled from 3.5 MHz to the CPC's 4 MHz. Listed in the Load picker. Save is a recording of what the machine wrote to the cassette since the last reset, not a re-save of the mounted tape: each firmware record (any SPEED WRITE speed) becomes a turbo block (0x11) holding its bytes verbatim (sync character, CRCs and trailer) with the measured timings; anything else that starts with a pilot tone is kept as exact pulse widths (CSW block 0x18). Named after the first header record, else `cpc-tape.cdt` |
| `.tzx` | Tape | Tape deck | ✅ | ✗ | Same parser as `.cdt` |
| `.tap` | Tape | Tape deck | ✅ | ✗ | Parsed by the shared TAP parser |
| `.dsk` | Disk | A: / B: | ✅ | ✅ | Standard and extended DSK; drive B via the drive pane. 664 / 6128 / 6128 Plus only |
| `.hfe` | Disk | A: / B: | ✅ | ✅ | HFE bitstream kept as the disk's identity; saved back as `.hfe` |
| `.scp` | Disk | A: / B: | ✅ | ✗ | SuperCard Pro flux image, decoded to tracks on load |
| `.cpr` | Cartridge | Cartridge slot | ✅ | ✗ | Plus models only (RIFF `AMS!`, up to 32 pages). A cartridge with page 0 replaces the firmware; one without page 0 overlays its pages onto the running firmware. The slot also takes a bare 16 KB ROM image as a one-page cartridge |

Blank disks for A: and B: can be created as DSK or HFE in the CPC System, CPC
Data and CPC IBM AMSDOS formats (alongside the PCW/+3 formats in the same menu).
Switching between CPC models keeps the disks in the drives.

**Save menu exports:** SNA v2 snapshot, SNA v3 snapshot, Saved tape (`.cdt`; not on the GX4000), PNG screenshot, `.scr`
screen dump (a raw copy of the 16 KB RAM bank the CRTC displays from; it does not
include Plus soft-scroll offsets or a split screen's second base, so use the PNG
for the exact picture), RAM `.bin` (`ram-64k.bin`, the 64 KB currently mapped
beneath the ROM overlays).

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| 1 µs Gate Array wait states | ✅ | Memory, I/O and interrupt-acknowledge cycles each start on their phase of the 4 T-state grid. Reproduces the published CPC "NOP" instruction timings |
| Raster timing | ✅ | HSYNC and VSYNC follow the CRTC registers; the interrupt counter clocks on the HSYNC falling edge and re-syncs on the second HSYNC after VSYNC onset |
| Mid-frame effects | ✅ | Screen mode, palette, CRTC and (Plus) scroll, split and sprites are applied per scanline |
| Overscan centring | ✅ | The active area is centred in the 768×272 frame buffer by its displayed width and height, so overscan displays stay centred |
| Colour maps | ✅ | Display pane: Basic (idealised levels), Gate Array (measured), ASIC (measured) |
| Border size | ✅ | None / small / normal crop of the frame buffer |
| Pixel aspect | ✅ | The frame buffer is 2× oversampled horizontally and is displayed at half width |
| Fast ROM loading | ✅ | Traps the firmware's CAS READ routine (found by signature scan of the lower ROM, so it works across 464/664/6128 ROMs) and delivers the next tape block straight into RAM. CRC-gated: any mismatch, wrong sync byte or custom loader falls through to real pulse-level loading |
| Turbo loading | ✅ | Runs flat out (audio skipped) while the firmware is reading the cassette |
| Loader detection | ◐ | Cadence-based: a burst of Port B reads under 500 T-states apart counts as loading and auto-plays a paused tape; a gap of 5000 T-states or more ends it. The motor bit is tracked for the UI but does not gate playback |
| Tape auto-rewind | ✅ | Optional: rewinds when the tape runs out |
| Tape sound | ✗ | Descriptor sets `tapeSound: false` |
| Media persistence | ◐ | Tapes and Plus cartridges come back after a reload; disks and snapshots do not |
| Disk sounds | ✅ | Shared floppy sound model, fed from the uPD765A's motor and track |
| Status LEDs | ✅ | Keyboard, mouse, text, sound chip, plus tape (not GX4000) and disk (disk models) |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | Z80 debug service shared with the Spectrum: breakpoints, memory and port watchpoints, step into/over/out, disassembly. Memory pane can show the lower ROM, BASIC and AMSDOS (cartridge pages 0, 1 and 3 on the Plus) |
| Memory layout pane | ✅ | Per 16 KB slot: the CPU-read source (ROM or RAM bank) and the RAM bank written beneath it, RAM configuration, selected upper ROM, video DMA bank, screen mode |
| Trace | ✅ | Full (address, disassembly, registers, T-states and operand context, with tight loops folded), a port I/O tally, and ZXTrace — the shared Z80 trace engine; a trace stops capturing at 500,000 lines |
| Screen OCR / TEXT overlay | ✅ | Reads the 20-, 40- or 80-column grid for the current screen mode against the character set in the lower ROM, normal and inverse video. Text drawn with a redefined font is not recognised |
| BASIC tools | ✅ | Locomotive BASIC listing and variables viewers read the program from RAM at &0170. The system-variables and font panes are hidden |
| Software library | ✗ | `library: false` |
| On-screen keyboard | ✅ | Separate layouts for the 464, 664 and 6128; the 6128 Plus reuses the 6128 layout. None for the GX4000 |
| Machine-specific panes | ✅ | Hardware pane: Multiface Two with STOP button, ParaDOS. Drives pane (disk models), tape pane (tape models), cartridge slot (Plus models), Mouse pane (Kempston / AMX) |
| MCP tools | ✅ | Generic tools (including `trace`, `stop_trace` and `trace_read`) plus `load` / `eject` (tape, drives A:/B:), `ocr`, `screenshot`, and the uPD765A inspectors `disk_geometry`, `track_geometry`, `sector_read`, `weak`, `fdc_log`. `key` accepts `f0`–`f9` for the keypad. These decline on a CPC: `multiface`, `vtx5000`, `plusd`, `betadisk`, `disk_boot`, `disk_trace`, `save` (SZX only), `frame_trace` |
| Drive count | ✅ | Disk models: one or two drives, chosen from **Drive count** in drive A's options menu. Saved per machine; rebuilds the machine. With one drive the uPD765A reports unit 1 not connected (equipment check on seek, not ready) |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| Plus coarse horizontal scroll not implemented | 6128 Plus, GX4000 | low | `applyScrollAndSplit` in `asic.ts` states a coarse horizontal scroll byte backstep "remains a later refinement"; horizontal scroll is applied only as a 0–15 pixel shift of the line start |
| Snapshot restore does not resume mid-frame | all | low | `applyCpcSna` in `cpc-sna.ts` does not restore the CRTC's internal counters (header bytes 0xA9–0xB1); the raster restarts at a frame boundary, which is where zx84's own saves are taken |
| Some game-only `.cpr` cartridges may not boot | 6128 Plus, GX4000 | low | `roms.ts` warns when bank 0 is not firmware (an upper ROM or custom loader): such cartridges "typically hang in emulators that don't model every ASIC quirk". The status line shows a warning on insert |

## Not emulated

- **Printer port.** Port B's printer-busy and expansion lines read as pulled high; nothing is attached.
- **RAM beyond the built-in memory.** The 64 KB block bits of the RAM command are decoded but wrap onto the installed banks; no expansion RAM is modelled. The 464 and 664 ignore the bank command altogether.
- **DDI-1 disk interface for the 464.** No controller is on the bus; the FDC ports float to 0xFF.
- **Light pen.** CRTC registers 16 and 17 never change; nothing models a pen strobe.
- **CRTC type selection.** Non-Plus models are fixed at type 0 and the Plus at type 4; types 1–3 exist in the core but cannot be chosen.
- **PPI configuration links.** Port B always reports Amstrad as manufacturer and 50 Hz.
- **464 Plus.** Snapshot type 5 is recognised as unmodelled and loads as a 6128.

## Faithful quirks

- **Main fire button is Fire 2.** A one-button CPC joystick wires its button to Fire 2, so the emulator's primary fire drives Fire 2 and the secondary drives Fire 1. Swapping them reverses Burnin' Rubber's launch and options.
- **Unmapped upper ROM falls back to BASIC.** Selecting a ROM number with nothing fitted reads the on-board BASIC ROM, which the firmware's own ROM-select code relies on. A genuinely absent ROM (and the Plus after a system cartridge without one) reads 0xFF so the boot-time ROM scan skips it.
- **Unmapped ports float high.** Reads from undecoded ports return 0xFF, and the FDC ports on the 464 and GX4000 do the same.
- **ASIC hides behind the lock.** Until the unlock sequence is written, the ASIC answers like a discrete Gate Array, so unmodified CPC software runs unchanged on a Plus.
- **ASIC ghost writes.** `IN` from the Gate Array or CRTC write ports performs a write of 0xFF on the Plus.
- **Interrupt acknowledge clears counter bit 5.** Servicing the 52-line interrupt leaves the counter at its low five bits, which is what makes raster splits stable.
- **AMX mouse pulses.** The mouse has no counters; each direction is a single low pulse retired when the driver deselects line 9, so reading without deselecting returns the same pulse forever.
- **Mode 3.** The undocumented mode decodes like mode 0 but honours only the low two pen bits (four colours).

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| `tests/cpc/cpc-wait-states.test.ts` | Instruction timings on the 1 µs grid compared with the CPCWiki CPC timing table and Caprice32's cycle tables, for every documented mnemonic group | — |
| `tests/cpc/cpc-raster-timing.test.ts`, `crtc-6845.test.ts`, `gate-array.test.ts` | VSYNC, HSYNC and interrupt-counter timing through the real frame loop; CRTC sequencing against the 6845 datasheet and standard CPC register values; 52-line interrupt, VSYNC re-sync and address scramble | — |
| `tests/cpc/asic.test.ts` | Locked-mode parity with the Gate Array; unlock state machine; RMR2; 12-bit palette; sprites; raster interrupt; soft scroll and split; DMA sound | — |
| `tests/cpc/cpc-boot.test.ts` | Boots to the BASIC 1.1 banner on 19,968 µs frames, then SAVE and CAT on a formatted disk. Skipped when the firmware ROMs are not in `mcp/.cache` | — |
| `tests/cpc/cpc-tape-instant-load.test.ts`, `cpc-tape-loader.test.ts`, `cpc-tape-io.test.ts` | CAS READ routine offsets found by scan on the 464, 664 and 6128 OS ROMs; CRC-gated block extraction; 1942 instant-loads on 464 and 6128 (skipped without ROMs and tape); PPI cassette bit and cadence gating | — |
| Fast ROM loading, trap on vs trap off, real CDTs (1942, 180, 10th Frame, 1943, 2048, 3D Starstrike) | CAS READ results and bytes identical on 464, 664 and 6128 | 2026-09-25 |
| `tests/cpc/cpc-multiface.test.ts`, `cpc-mouse.test.ts`, `cpc-keyboard.test.ts`, `joystick-fire.test.ts` | Multiface port decode, paging and NMI; Kempston and AMX behaviour; joystick matrix lines; fire-button mapping | — |
| `tests/cpc/plus-analogue.test.ts` | ASIC analogue channel map, direction and tied-off levels from CPCWiki's measurements of a real Plus, read through the unlocked register window; read-only writes; proportional input and the digital port; held stick across a reset | — |
| `tests/cpc/cpc-memory.test.ts`, `cpc-fdc-ports.test.ts`, `cpc-models.test.ts`, `plus-debug.test.ts`, `render-centering.test.ts` | ROM split and paging; FDC port decode (absent on 464 and GX4000); model classification; Plus cartridge boot; display centring | — |
| `tests/cpc/cpc-tape-save.test.ts` | Recorded records against the firmware guide's cassette format and the TZX 0x11 layout; CAS WRITE then CAS READ of the recording on the real 464 and 6128 firmware, at pulse level and through the fast-load trap (skipped without ROMs) | — |
| `tests/machines/cpc/media-routing.test.ts` | Extension routing to tape, snapshot (with model auto-switch), disk and cartridge; `.cpr` refused on non-Plus models | — |
| `tests/cpc/cpc-screen-text.test.ts`, `tests/basic/cpc-basic-parser.test.ts` | OCR across screen modes; Locomotive BASIC detokenizer against byte sequences captured from the real 6128 firmware | — |
