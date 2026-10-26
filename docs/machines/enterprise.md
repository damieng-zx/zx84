# Enterprise 64 and 128

A British Z80 home computer built around two custom chips: Nick, which draws
the picture from a list of per-line mode records in video RAM, and Dave, which
pages a 4 MB address space into the Z80's 64 KB and also provides sound, timers
and interrupts. zx84 emulates both models with Nick drawn a scanline at a time
in every video mode, Dave's paging, wait states, interrupts and stereo sound,
an optional EXDOS disk card, and an emulated FILE: device that runs bare EXOS
programs straight from the host.

| | |
| --- | --- |
| **Manufacturer** | Enterprise Computers (UK) |
| **Released** | 1985 |
| **CPU** | Zilog Z80A — 4 MHz (Dave's 8 MHz input divided by two) |
| **zx84 kind** | `enterprise` — [`src/machines/enterprise/`](../../src/machines/enterprise/) |
| **Model ids** | `ep64` `ep128` — the MCP `model` target and `?model=` value |
| **Accuracy** | Per-T-state CPU with Dave's memory wait states and Nick's video-RAM slot waits; Nick drawn per scanline (256 T-states × 312 lines = 79,872 T-states per frame). No accuracy setting (`descriptor.ui.accuracy` is off) |
| **Status** | Boots EXOS 2.0/2.1 and IS-BASIC 2.1; FILE: and EXDOS loading are boot-tested against the real ROMs |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Enterprise 64 (`ep64`) | 1985 | 64 KB (segments 0xFC–0xFF) | EXOS 2.0 + IS-BASIC 2.1 cartridge (16 KB) | Nick | Dave (stereo) | FILE: device; optional EXDOS card | All RAM is Nick's video RAM, so every CPU access to it can wait for Nick |
| Enterprise 128 (`ep128`) | 1985 | 128 KB (segments 0xF8–0xFF) | EXOS 2.1 + IS-BASIC 2.1 cartridge (16 KB) | Nick | Dave (stereo) | FILE: device; optional EXDOS card | Segments 0xF8–0xFB are RAM Nick cannot see: the CPU reaches them without video waits |

Both models are one board with 64 KB or 128 KB fitted. The frame is 768 × 288
pixels with half-width pixels (pixel aspect 0.5); the border is a single Nick
colour, so the border-size setting has no effect.

### ROM sets

All system ROMs are fetched from the ROM host; there is one locale (UK). Any of
the images can be replaced from the ROM pane.

| Model | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| `ep64` | UK | `enterprise/exos20.rom` then `enterprise/basic21.rom` | hosted |
| `ep128` | UK | `enterprise/exos21.rom` then `enterprise/basic21.rom` | hosted |
| EXDOS card (either model) | — | `enterprise/exdos13.rom` (EXDOS 1.3, up to 32 KB at segments 0x20–0x21) | hosted |

The ROM pane has one system slot holding the combined image: EXOS first, then
the BASIC cartridge. EXOS occupies up to four segments from segment 0x00; the
cartridge image goes at segments 0x04–0x07. A dropped raw ROM of 32 KB, 48 KB,
64 KB or 80 KB (EXOS alone, or EXOS plus BASIC) is accepted as a system ROM only
when an Enterprise is already running, because those sizes belong to other
machines too. A 48 KB or 80 KB image is split as EXOS plus a 16 KB cartridge.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| Z80A CPU | both | ✅ | Shared core [`src/cores/z80.ts`](../../src/cores/) |
| Nick (video) | both | ✅ | [`nick.ts`](../../src/machines/enterprise/nick.ts). Walks the line parameter table in video RAM; per-block mode, margins, data pointers and an eight-entry palette. Modes: VSYNC, pixel, low-resolution pixel, attribute, and the three character modes (256, 128 and 64 characters); colour modes of 2, 4, 16 and 256 colours; LSBALT/MSBALT and ALTIND alternative palettes; FIXBIAS (port 0x80) for palette entries 8–15; border (port 0x81). Mode 6 is not a defined mode and draws blank |
| Nick colour | both | ✅ | Fixed 256-colour DAC (3 bits red, 3 green, 2 blue); there is no palette to choose |
| Dave (sound) | both | ✅ | [`dave.ts`](../../src/machines/enterprise/dave.ts). Three tone channels with 12-bit dividers, optional 4/5/7-bit polynomial distortion, high-pass and ring modulation between channels; a noise channel clocked from a 31.25 kHz oscillator or a tone; 6-bit left and right volume per channel; DAC mode on channel 0. Stereo output |
| Dave (timers and interrupts) | both | ✅ | 1 kHz / 50 Hz / tone-driven sound interrupt, 1 Hz interrupt, INT1 from Nick's VINT; per-source enable and latch (port 0xB4). Input clock 8 MHz or 12 MHz per port 0xBF |
| Dave (memory paging) | both | ✅ | [`memory.ts`](../../src/machines/enterprise/memory.ts). Any four of 256 16 KB segments into the Z80's four pages (ports 0xB0–0xB3, readable). Empty segments read 0xFF and ignore writes; ROM segments ignore writes |
| Wait states | both | ✅ | Dave port 0xBF: wait on all non-video accesses, on M1 only, or none. Accesses to video RAM and Nick's ports wait for Nick's next free slot |
| Keyboard | both | ✅ | Ten-row active-low matrix on port 0xB5; host keys map by position onto a UK-style layout (see Tools) |
| Built-in joystick | both | ✅ | Wired into the keyboard matrix (cursor keys on row 7, fire on space); no separate device |
| Cassette interface | both | ✗ | Remote relay bits are stored; no tape deck and no tape input |
| Serial and printer ports | both | ✗ | See Not emulated |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| EXDOS disk card | disk | both | ✅ | Hardware pane checkbox "EXDOS disk card", on by default. WD1770 at ports 0x10–0x13 (mirrored to 0x17), control and status latch at 0x18–0x1F, EXDOS 1.3 ROM. Four drives A:–D: of 720 KB 3.5" disks (9 sectors a track). Toggling it rebuilds the machine. Drives pane appears while it is fitted |
| Extension ROM sockets (×4) | ROM | both | ✅ | ROM pane, "Extension ROM 1–4". Up to 32 KB each, at segments 0x30, 0x32, 0x34, 0x36; EXOS finds a newly fitted ROM at the next reset. Empty by default. EPDOS (HFONT) and ZozoTools commands are extension ROMs: a program that calls one without it stops with "Unrecognised command string" |
| FILE: device | ROM / host files | both | ✅ | zx84's own EXOS extension ROM at segment 0x10, fitted only while files are mounted. EXOS opens, reads, creates, writes and deletes files on it; the machine traps the device's entry points and serves them from the mounted files. Names are matched case-blind, with or without extension, directory and drive parts dropped. Files a program creates are held in memory only |

**Combination rules:** disks mount only while the EXDOS card is fitted. Mounting
programs through FILE: with the card fitted also writes the same files to a
fresh disk in A: (when they fit in 112 root entries and 720 KB), because many
loaders name their next part on `DISK:`/`A:`. Mounting a disk in A: removes the
FILE: files and restarts the machine. The four extension sockets are
independent of both.

---

## Media formats

ZIP archives are offered whole to the Enterprise first (see `.zip` below).

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.com`, `.bas` | EXOS program | FILE: | ✅ | ✗ | Offered on their own, along with `.prg`, `.ep`, `.app` and `.exe`. Any file is checked by header, not extension: first byte 0, module type 2–7 (BASIC uses type 4, a program type 5) or it is refused |
| `.zip` | Multi-file program set | FILE: | ✅ | ✗ | All files mount as one set, because multi-part programs load their other parts by name. The key file is a runnable file named after the archive, else the first `.com`/`.bas`, else the first runnable file. An archive containing an `.img` is handed to the ordinary disk path instead; one with no runnable file falls back to the standard ZIP picker |
| `.img` | Disk (raw FAT12 sector dump) | EXDOS card, drives A:–D: | ✅ | ✅ | Needs the EXDOS card fitted. Geometry from the boot sector, else from the standard file sizes (720 KB, 360 KB, 1.44 MB and others). Saved from the Drives pane as `.img` |

Loading a program resets the machine, fits the FILE: ROM and types `RUN "FILE:"`
at the start-up screen. Loading a disk into A: resets and starts it: nothing if
it has an `EXDOS.INI`, `RUN` of the program if it has exactly one `.COM`/`.BAS`
with an EXOS header, otherwise a `:DIR` listing (a lone IS-DOS program cannot be
run from BASIC).

Blank disks can be created in the Drives pane: 720 KB double-sided 80-track or
360 KB double-sided 40-track, pre-formatted FAT12.

**Save menu exports:** PNG screenshot, RAM `.bin` (all fitted RAM, 64 KB or
128 KB).

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Bus timing | ✅ | Dave wait modes plus video-RAM waits for Nick's free slot (Nick keeps ten of every sixteen clocks for display fetch) |
| Per-scanline display | ✅ | Frame follows the line parameter table; the frame row counter restarts at the end of the VSYNC block |
| Boot turbo | ✅ | Runs flat out while the typer is driving a program or disk start (follows the "turbo while loading" setting) |
| Automatic start | ✅ | Typer presses a key at the start-up screen then types the start command; gives up after one emulated minute if the ROM never scans the keyboard |
| Media persistence | ✅ | `persistMedia` is on, so mounted disks come back after a reload |
| Disk sounds | ✅ | Fixed 3.5" drive profile; drive LEDs show motor, read and write, with track and sector |
| Frame probe indicators | ✅ | Status LEDs for keyboard, load (FILE: access), disk and sound chip |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | Z80 debug service; breakpoints, step, memory and port watchpoints, registers |
| Memory pane | ✅ | Shows each 16 KB Z80 page's segment (EXOS, Cartridge, FILE: ROM, EXDOS, RAM, VRAM, empty), the wait-state mode, the line parameter table base and the border |
| Trace | ✗ | `startTrace` is a stub; the trace UI is off for this machine |
| Screen OCR / TEXT overlay | ✅ | Reads character-mode text from Nick's line parameter table rather than from pixels; bitmap-mode screens return no text |
| Software library | ✗ | Not available |
| On-screen keyboard | ✗ | None; host keyboard only |
| Host keyboard | ✅ | Positional UK-style mapping onto the matrix; Alt is the Enterprise ALT key, Home is HOLD, Pause/End is STOP, Insert/Delete/Backspace map to INS/DEL/ERASE |
| Hidden panes | — | Tape, microdrive, mouse, joystick and system-variables panes are hidden |
| MCP tools | ✅ | Generic execution, register, memory, disassembly, breakpoint/watchpoint, trap, port, `key`, `type`, `ocr`, `screenshot`, `load` and `eject` tools. `type` presses characters on the typer's layer rather than by key name. No Enterprise-specific tools: the disk inspection tools (`disk_geometry`, `track_geometry`, `sector_read`, `weak`, `fdc_log`) only attach to the Spectrum +3 and CPC controllers, and nothing in the MCP toggles the EXDOS card |
| Drive count | ✅ | One to four EXDOS drives, from **Drive count** in drive A's options menu; saved, rebuilds the machine. Unconnected units give a seek error |

---

## Known issues

None known.

## Not emulated

- **Serial port.** Port 0xB7 reads 0xFF and writes are ignored.
- **Printer port.** Port 0xB6 data writes are ignored and reads return a constant 0xFF.
- **External joystick inputs and tape input.** Port 0xB6 returns 0xFF, so nothing is attached.
- **Cassette.** No tape service; Dave's remote relay bits are stored but drive nothing.
- **Dave INT2.** The external input is unused.
- **EXDOS single-density select.** Control bit 5 is not acted on; only double-density 3.5" disks exist.
- **Snapshots.** No snapshot format is loaded or saved.
- **Disk formats other than `.img`.** HFE, SCP, DSK and the other formats are not accepted.
- **Saving files made through FILE:.** Files a program creates on the FILE: device live in memory only and cannot be downloaded.

## Faithful quirks

- **Empty drive A: slows the boot.** With the EXDOS card fitted and no disk in A:, EXDOS waits out its read timeout several times (about sixteen seconds before BASIC): a WD1770 with no disk never sees an index pulse. Mounting any program or disk avoids it, since a disk is put in A:.
- **Video RAM accesses are slower than other RAM.** The 64's RAM is all video RAM, so its CPU accesses wait for Nick; on the 128, segments 0xF8–0xFB do not.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| `tests/enterprise/enterprise-hardware.test.ts` | Nick colour byte decode, 2/4-colour pixel and attribute slots, VINT; Dave 1 kHz, 50 Hz, tone and 1 Hz interrupts and latch/enable; segment layout on the 64 and 128 and ROM write protection; keyboard port B5 and cursor keys on row 7; FILE: ROM signature, descriptor, traps, file open/read and EXOS header type; FAT12 blank-disk format and root directory listing | — |
| `tests/enterprise/enterprise-boot.test.ts` (real EXOS 2.1, IS-BASIC 2.1, EXDOS 1.3) | Starts IS-BASIC and evaluates `PRINT 6*7`; runs a program from FILE:; runs a program from an EXDOS disk in A:. Skipped when the ROMs are absent from `mcp/.cache` or `EP_ROM_DIR` | — |
| Enterprise software collection (1,688 zips, headless, 1,500 frames each) | 1,624 ran clean. Expected non-failures: 39 titles needing an extension-ROM BASIC, 7 IS-DOS programs that need an IS-DOS system disk, and slow Spectrum conversions that need more than 1,500 frames | 2026-10-18 |
