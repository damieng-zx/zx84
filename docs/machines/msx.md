# MSX (Toshiba HX-10, Sony HB-55 and HB-55P)

Toshiba's MSX1 home computer: a Z80, a TMS9929A video chip, an AY-3-8910-compatible sound chip and MSX BASIC in ROM, with four primary memory slots selected through an 8255 PPI. zx84 emulates the Toshiba HX-10 (PAL) and the Sony HB-55 (Japan, NTSC) and HB-55P (PAL), each with its cartridge slot, cassette interface and two joystick ports, plus an optional WD2793 floppy disk interface in the rear expansion slot.

| | |
| --- | --- |
| **Manufacturer** | Toshiba, Sony (MSX1 standard) |
| **Released** | — |
| **CPU** | Z80 — 3.579545 MHz, one WAIT state added to each opcode fetch |
| **zx84 kind** | `msx` — [`src/machines/msx/`](../../src/machines/msx/) |
| **Model ids** | `hx-10`, `hb-55`, `hb-55p` — the MCP `model` target and `?model=` value |
| **Accuracy** | Scanline: the CPU runs line by line (313 lines per 50 Hz field on PAL models, 262 lines per 60 Hz field on the NTSC HB-55) and the VDP renders each active line after it; no memory contention; no accuracy setting |
| **Status** | Boots to MSX BASIC; keyboard, joysticks, cartridges (including mega-ROM mappers), cassette load and save, and the optional floppy interface all work |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sony HB-55 (`hb-55`) | 1983 | 16 KB (slot 0, page 3) | 32 KB (BIOS + MSX BASIC 1.0, Japanese character set) + optional 8 KB Personal Data Bank | TMS9918A, 256×192, NTSC 60 Hz | AY-3-8910 PSG + key click | Cassette (`.cas`); cartridge slot; optional floppy interface | 59,736 T-states per field (262 lines × 228); JIS keyboard (the matrix is the standard one, the BIOS key table differs; かな = the CODE key); no secondary-slot expansion |
| Sony HB-55P (`hb-55p`) | 1984 | 16 KB (slot 0, page 3) | 32 KB (BIOS + MSX BASIC 1.0) + optional 16 KB Personal Data Bank | TMS9929A, 256×192, PAL 50 Hz | AY-3-8910 PSG + key click | Cassette (`.cas`); cartridge slot; optional floppy interface | 71,591 T-states per frame; UK keyboard layout; with the Data Bank ROM it boots to the Sony menu, whose BASIC entry reaches the prompt; no secondary-slot expansion |
| Toshiba HX-10 (`hx-10`) | — | 64 KB (slot 2) | 32 KB (BIOS + MSX BASIC 1.0) | TMS9929A, 256×192, PAL 50 Hz | AY-3-8910 PSG + key click | Cassette (`.cas`); cartridge slot; optional floppy interface | 71,591 T-states per frame; UK keyboard layout; no secondary-slot expansion |

### ROM sets

All ROMs are fetched from the ROM host on demand.

| Model | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| `hx-10` | UK | One 32 KB image: BIOS + MSX BASIC (`hx-10_basic-bios1.rom`) | hosted |
| `hb-55` | Japan | One 32 KB image: BIOS + MSX BASIC (`hb-55_basic-bios1.rom`, SHA-1 302afb5d…) | hosted |
| `hb-55` Data Bank | Japan | Optional 8 KB Personal Data Bank (`hb-55_firmware.rom`, MAME `hb55note.rom`) | not hosted yet; the machine runs without it |
| `hb-55p` | UK | One 32 KB image: BIOS + MSX BASIC (`hb-55p_basic-bios1.rom`, SHA-1 8963fc04…) | hosted |
| `hb-55p` Data Bank | UK | Optional 16 KB Personal Data Bank (`hb-55p_firmware.rom`, SHA-1 b262aedc…) | hosted |
| `hx-10` floppy interface | — | One 16 KB Disk BASIC ROM (`msx1_disk-basic.rom`), fetched only when the interface is fitted | hosted |

The system ROM can be replaced from the ROM / Carts pane (the image is truncated or padded to 32 KB); resetting the slot restores the hosted ROM. The Memory pane can show the internal ROM (`ROM 0`) and, when the floppy interface is fitted, the Disk ROM.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| Z80 CPU | all | ✅ | Shared core [`src/cores/z80.ts`](../../src/cores/z80.ts); one M1 WAIT state per opcode fetch (5 T-states for NOP) |
| TMS9929A VDP | all | ◐ | [`src/cores/tms9918a.ts`](../../src/cores/tms9918a.ts). Text (40×24), Graphics I, Graphics II, Multicolor and sprites (32, four per line). The core documents Multicolor mode and exact 5th-sprite/coincidence reporting as approximations. Vertical blank is raised after line 192 and drives the Z80 /INT in interrupt mode 1 |
| AY-3-8910 PSG | all | ✅ | Shared core [`src/cores/ay-3-8910.ts`](../../src/cores/ay-3-8910.ts), clocked at 1.789772 MHz (half the CPU clock); stereo placement (ABC by default), filter and DC-block controls |
| Key click | all | ✅ | 8255 port C bit 7, mixed into the 1-bit sound path |
| Intel 8255 PPI | all | ✅ | Ports 0xA8–0xAB: port A = primary-slot select, port B = keyboard columns, port C = keyboard row (low nibble) plus key click (bit 7), control port with mode-set and bit set/reset |
| Primary-slot memory | all | ✅ | [`msx-memory.ts`](../../src/machines/msx/msx-memory.ts). Four 16 KB pages, each selecting one of four slots: slot 0 = ROM (pages 0–1; pages 2–3 empty), slot 1 = cartridge, slot 2 = 64 KB RAM, slot 3 = rear expansion (empty unless the floppy interface is fitted). Empty areas read 0xFF; no secondary slots |
| Keyboard matrix | all | ✅ | 11 rows × 8 columns, active-low, scanned through the PPI. Host keys map by physical key code; Numpad keys map to rows 9–10 |
| Joystick ports | all | ✅ | Two Atari-style ports read through PSG registers 14 and 15 (see Peripherals) |
| Cassette interface | all | ◐ | Byte-level via BIOS routine traps, not pulse-level (see Emulation features) |

I/O ports are decoded on the low byte: VDP 0x98/0x99, PSG 0xA0/0xA1/0xA2, PPI 0xA8–0xAB.

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Joystick, ports 1 and 2 | Input | `hx-10` | ✅ | Up/down/left/right, trigger A (fire) and trigger B (fire 2). The Joystick pane has no type selector: the player number picks the port |
| Cartridge slot (slot 1) | ROM | `hx-10` | ✅ | `.rom` images; plain ROMs and four mega-ROM mappers. Inserting or ejecting power-cycles the machine so the BIOS slot scan finds the cartridge |
| Floppy disk interface (slot 3) | Disk | `hx-10` | ✅ | Hardware-pane checkbox "Floppy (disk interface)", off by default. WD2793 with Disk BASIC ROM; two 3.5-inch drives A: and B:, per-drive write protect |

**Cartridge handling.** A plain image is placed by its `AB` header (INIT/STATEMENT/DEVICE/TEXT pointers decide which 16 KB page it starts in; 8 KB images mirror across their page). A mega-ROM is any image over 64 KB, or a 64 KB image starting with `AB`; its mapper is guessed from `LD (nnnn),A` stores to bank registers: ASCII 8 KB, ASCII 16 KB, Konami, or Konami SCC. Mega-ROMs decode 0x4000–0xBFFF only. A reset keeps the cartridge in place and restores power-on banking.

**Floppy interface.** The interface only appears once it is enabled and its Disk BASIC ROM has loaded. The BIOS finds it in its power-on slot scan, so fitting or removing it resets the machine. Removing it ejects both drives. The ROM appears at 0x4000 and mirrors at 0x8000 (the card decodes only A0–A13), with the controller registers overlaying the top of the image. Two register layouts exist; the layout is chosen automatically from the address constants in the ROM:

| Layout | Registers | Drive select | Flags |
| --- | --- | --- | --- |
| Standard | 0x7FF8–0x7FFB; side 0x7FFC; drive and motor 0x7FFD | Binary in bits 0–1 (0 = A:, 1 = B:, 3 = none); motor bit 7 | 0x7FFF: DRQ bit 6 and INTRQ bit 7, both active high |
| Compact | 0x7FB8–0x7FBB; combined latch 0x7FBC | One-hot bits 0–1; side bit 2; motor bit 3 | 0x7FBC: INTRQ bit 7 active high, DRQ bit 6 active low |

**Combination rules:** Floppy interface and cartridge occupy different slots (3 and 1) and can be used together. A disk image can only be mounted while the interface is fitted; otherwise the load is refused with a message pointing at the Hardware pane.

---

## Media formats

ZIP archives are unpacked and their contents routed as below. The Load picker offers `.rom`, `.cas` and `.zip`, plus the disk extensions while the floppy interface is fitted.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.rom` | Cartridge | Slot 1 | ✅ | — | Mounting power-cycles the machine. Not restored after a reload |
| `.cas` | Cassette | Cassette | ✅ | ✅ | Served through BIOS traps (`CLOAD`, `BLOAD"CAS:"`). Save exports what the BIOS has written since the last reset (see below). A mounted cassette is restored after a reload |
| `.dsk` | Disk | Drive A: (or B:) | ✅ | ✅ | Headerless 512-byte-sector dump: 160K, 180K, 320K, 360K, 640K or 720K. Geometry comes from the FAT media descriptor, not only the file size; trimmed and padded dumps are accepted. Saved as `.dsk` when every sector is clean and regular |
| `.img` | Disk | Drive A: (or B:) | ✅ | ◐ | One header byte (1 or 2) before a 360K or 720K dump. Saved back as `.dsk` |
| `.dmk` | Disk | Drive A: (or B:) | ✅ | ◐ | Keeps CRC errors, deleted-data marks and odd layouts. Saved as `.edsk` when irregular, otherwise `.dsk` |
| `.hfe` | Disk | Drive A: (or B:) | ✅ | ✅ | HFE v1 bitstream; HFE-sourced disks save back as `.hfe` |
| `.scp` | Disk | Drive A: (or B:) | ✅ | ◐ | Flux image. Saved as `.dsk`, or `.edsk` when irregular |
| `.td0` | Disk | Drive A: (or B:) | ✅ | ◐ | Teledisk. Saved as `.dsk`, or `.edsk` when irregular |
| `.edsk` | Disk | Drive A: (or B:) | ✅ | ✅ | Extended CPC DSK container; used for irregular disks a plain dump cannot hold |

Disk images load into drive A: unless the target is drive B:. Blank disks can be created from the Drives pane ("MSX-DOS image"): 720K double-sided/80-track or 360K single-sided/80-track, each with a valid FAT12 volume and boot sector. A completed format (WRITE TRACK) is re-detected so the Drives pane stays accurate.

**Save menu exports:** Saved tape (`.cas`, only after the machine has saved something; named from the first saved file header, else `msx.cas`), PNG screenshot, `.scr` screen dump (the 16 KB VDP VRAM), RAM `.bin` (the 64 KB RAM, `ram-64k.bin`). Disks are saved from the Drives pane. There is no snapshot format.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Opcode wait states | ✅ | The MSX adds one WAIT clock to each M1 fetch; checked against published Z80+M1 timings (see Verification) |
| Memory contention | — | None on the MSX |
| Cassette load | ◐ | BIOS traps on TAPION (0x00E1) and TAPIN (0x00E4) serve a mounted `.cas` instantly while the BIOS ROM is in page 0. The block list shows BASIC / Binary / ASCII headers and file names, can merge header and data rows, and highlights the block being read. The Tape pane's play, pause and seek controls do nothing; rewind works |
| Cassette save | ✅ | Traps on TAPOON (0x00EA) and TAPOUT (0x00ED) record `CSAVE` / `BSAVE"CAS:"` output as a `.cas` stream, cleared on reset |
| Colour map | ✅ | Display pane selects PAL (default) or NTSC colours |
| Border size | ✅ | None / small / normal around the 256×192 active area (320×240 output) |
| Sound | ✅ | PSG stereo mode, filter and DC-block settings and master volume apply |
| Disk activity | ✅ | Drive LEDs, track and sector display, and drive sounds using a 3.5-inch profile |
| Media persistence | ◐ | The cassette comes back after a reload; cartridges and disks do not |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger | ✅ | Shared Z80 debugger: breakpoints, stepping, disassembly, registers, memory and port watchpoints |
| Trace | ✗ | Not offered: the descriptor has tracing off and the MCP `trace` tool declines on every machine except the Spectrum |
| Screen OCR / TEXT overlay | ✅ | Reads the VDP name table directly in SCREEN 0 (40×24) and SCREEN 1 (32×24); other modes return a note |
| BASIC tools | ✅ | MSX BASIC listing and variables, parsed from the BASIC work area in RAM |
| Memory Layout pane | ✅ | Shows what each 16 KB page selects (ROM, cartridge, RAM, Disk ROM, empty), the PPI port A value, and the active cartridge mapper |
| Software library | ✗ | Not available for this machine |
| On-screen keyboard | ✅ | UK Toshiba HX-10P layout, 73 keys covering matrix rows 0–8 |
| ROM / Carts pane | ✅ | System ROM replacement and cartridge insert/eject |
| Drives pane | ✅ | Shown only while the floppy interface is fitted |
| MCP tools | ✅ | Generic tools (execution, registers, memory, breakpoints and watchpoints, ports, `key`, `type`, `load`, `eject`, `screenshot`, `ocr`, `model`), plus `msxdisk` (`on`, `off`, `status`) to fit or remove the floppy interface. The `trace`, `save` (SZX), and +3/CPC disk-inspection tools (`disk_geometry`, `track_geometry`, `sector_read`, `weak`) do not apply to this machine |
| Drive count | ✅ | One or two drives on the floppy interface, from **Drive count** in drive A's options menu; saved, rebuilds the machine. Unconnected units give a seek error and stay not-ready |

---

## Known issues

None known.

## Not emulated

- **Pulse-level cassette.** Custom turbo loaders that sample the cassette port directly are not covered; only the BIOS routines are served. The cassette input bit (PSG register 14 bit 7) always reads idle.
- **Secondary slots on a real model.** None of the three models has any, so 0xFFFF is plain memory. The expansion register itself is implemented generically in `MsxMemory` behind a layout flag (`expansions`) and unit-tested, but no model enables it.
- **SCC sound.** The Konami SCC mapper's bank switching is modelled; the SCC sound chip is not.
- **Cartridge mappers other than ASCII 8 KB, ASCII 16 KB, Konami and Konami SCC.** A mega-ROM with no recognisable bank-register stores falls back to ASCII 8 KB.
- **Other expansion hardware.** Slot 3 holds only the floppy interface; otherwise it reads as empty. There is no second cartridge slot.
- **Single-drive disk configuration.** The interface always presents two drives, A: and B:.
- **1.44 MB high-density disks.** Rejected with an error (MSX1 interfaces are double density).
- **HFE v3 images.** Rejected with an error.
- **Snapshots.** There is no snapshot format or service.
- **Execution trace.** Only the Spectrum has a trace engine; the trace menu is not offered here.
- **Numeric keypad hardware.** The HX-10 keyboard has none, so the on-screen keyboard has no keypad; host Numpad keys still map to matrix rows 9–10.

## Faithful quirks

- **Writes to ROM are dropped.** The internal ROM, empty slots and cartridge ROM ignore writes; a mega-ROM cartridge treats writes as bank-register writes.
- **Empty slots read 0xFF.** Unpopulated pages (slot 0 pages 2–3, an empty cartridge slot, an unfitted slot 3) return 0xFF.
- **An 8255 mode-set clears the output latches.** Writing a mode word to the PPI control port resets port A (slot select) and port C, as the datasheet specifies.
- **Disk ROM and registers mirror into page 2.** The card decodes only A0–A13, and MSX-DOS relies on this by polling the controller at 0xBFF8.
- **Drive-select encodings differ between the two card families.** Standard cards select drives in binary; compact cards use one-hot bits. Compact DRQ is active low.
- **A deselected drive looks not ready.** Drive-select values that name neither A: nor B: leave the controller with a not-ready drive.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| Opcode timing, [`tests/msx/msx-timing.test.ts`](../../tests/msx/msx-timing.test.ts) | Instruction cycle counts with the M1 wait state match published Z80+M1 timings for NOP, loads, CB/ED/DD/FD prefixes, HALT and LDIR | — |
| Slot paging and cartridges, [`tests/msx/msx-memory.test.ts`](../../tests/msx/msx-memory.test.ts) | Slot mapping, empty-slot reads, cartridge placement by `AB` header, mirroring, reset behaviour | — |
| Mega-ROM mappers, [`tests/msx/msx-megarom.test.ts`](../../tests/msx/msx-megarom.test.ts) | ASCII 8, ASCII 16, Konami and Konami SCC bank switching and mapper detection | — |
| PPI, keyboard, joystick, [`msx-io`](../../tests/msx/msx-io.test.ts), [`msx-keyboard`](../../tests/msx/msx-keyboard.test.ts), [`msx-joystick`](../../tests/msx/msx-joystick.test.ts) | PPI slot select, row scan, BSR and mode-set; matrix cells; PSG-based joystick read; key click | — |
| Cassette and OCR, [`msx-tape`](../../tests/msx/msx-tape.test.ts), [`msx-screen-text`](../../tests/msx/msx-screen-text.test.ts) | `.cas` header search and block listing; TAPOON/TAPOUT recording; name-table OCR per mode | — |
| Floppy interface, [`tests/msx/msx-disk-interface.test.ts`](../../tests/msx/msx-disk-interface.test.ts) | Both register layouts, layout detection, slot-3 mapping and page-2 mirror, read/write/protect, disk service and media routing; the BIOS slot-scan case runs only when the BIOS ROM is cached locally | — |
| Disk image formats, [`tests/floppy/msx-disk.test.ts`](../../tests/floppy/msx-disk.test.ts) | Geometry from media descriptor, trimmed and padded dumps, `.img`, DMK decoding, blank-disk layout | — |
| Media routing, [`tests/machines/msx/media-routing.test.ts`](../../tests/machines/msx/media-routing.test.ts) | `.rom` and `.cas` routing, disk refusal until the interface is fitted | — |
| Real Disk BASIC ROMs, [`tests/msx/msx-disk-real-rom.test.ts`](../../tests/msx/msx-disk-real-rom.test.ts) | Boots MSX-DOS, lists A:, copies to B:; skipped unless the ROM and disk paths are supplied through environment variables | — |
| HB-55 and HB-55P, [`msx-hb55`](../../tests/msx/msx-hb55.test.ts), [`msx-hb55p`](../../tests/msx/msx-hb55p.test.ts), [`msx-hb55-real`](../../tests/msx/msx-hb55-real.test.ts), [`msx-expansion`](../../tests/msx/msx-expansion.test.ts) | Slot-0 RAM and Data Bank layout, NTSC/PAL field timing, kana key and LED, the 0xFFFF expansion register, and real-BIOS boots (skipped without the ROMs in `mcp/.cache`) | — |
| HX-10 keyboard geometry, [`tests/ui/hx10-keyboard-geometry.test.ts`](../../tests/ui/hx10-keyboard-geometry.test.ts) | 73 caps cover every matrix cell in rows 0–8 | — |
| Real HB-55 (Japanese) and HB-55P BIOS | Both boot to "MSX BASIC version 1.0" with about 12 KB free (16 KB RAM); `PRINT 2+2` prints 4 (the Japanese BIOS needs `+` typed as Shift+`;`); the HB-55P Data Bank menu reaches BASIC; a slot-1 cartridge INIT runs | 2026-10-18 |
| Real HX-10 BIOS | Boots to "MSX BASIC version 1.0" with 28815 bytes free; `PRINT 2+2` prints 4 | 2026-07-17 |
| Synthetic `.cas` | `CLOAD` finds the file, `RUN` executes it | 2026-07-17 |
| Real Disk BASIC ROMs from several vendors with MSX-DOS 1.03 | Boots from a real disk; `DIR`, `COPY` and `FORMAT` work; the formatted disk parses byte-for-byte in an independent FAT12 reader. About 110 game and application disks reached title screens, loaders or DOS | 2026-10-18 |
| Disk image collection | All 2232 `.dsk` files in the collection parse | 2026-10-18 |
