# Sinclair ZX Spectrum

Sinclair's Z80 home computer and the Amstrad-era models that followed it. zx84
emulates the whole family from the 16K to the +3, with the Ferranti ULA and the
Amstrad gate array modelled separately, and most of the period disk, ROM and
input add-ons.

| | |
| --- | --- |
| **Manufacturer** | Sinclair Research (16K–128K); Amstrad (+2, +2A, +3). Spanish models by Investrónica |
| **Released** | 1982–1987 |
| **CPU** | Zilog Z80A — 3.5 MHz (16K/48K), 3.5469 MHz (128K-class) |
| **zx84 kind** | `spectrum` — [`src/machines/spectrum/`](../../src/machines/spectrum/) |
| **Model ids** | `16k` `48k` `128k` `+2` `+2A` `+3` — the MCP `model` target and `?model=` value (in a URL write `+` as `plus` or `%2B`: `?model=plus2a`) |
| **Accuracy** | Per-T-state CPU and contention; scanline display with mid-line (rainbow) rendering |
| **Status** | Mature — passes azesmbog's ULA timing tests on 48K, 128K and +3 |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 16K (`16k`) | 1982 | 16 KB | 16 KB | Ferranti ULA | Beeper | Cassette | Upper 32 KB unfitted: reads 0xFF, writes dropped |
| 48K (`48k`) | 1982 | 48 KB | 16 KB | Ferranti ULA | Beeper | Cassette | 224 T/line × 312 lines = 69,888 T/frame |
| 128K (`128k`) | 1985 | 128 KB | 32 KB (2 pages) | Ferranti ULA | Beeper + AY-3-8912 | Cassette | 7FFD paging; 228 T/line × 311 lines = 70,908 T/frame |
| +2 (`+2`) | 1986 | 128 KB | 32 KB (2 pages) | Ferranti ULA | Beeper + AY-3-8912 | Built-in cassette | Same board design as the 128K, Amstrad ROM |
| +2A (`+2A`) | 1987 | 128 KB | 64 KB (4 pages) | Amstrad gate array | Beeper + AY-3-8912 | Built-in cassette | 1FFD paging incl. special all-RAM modes |
| +3 (`+3`) | 1987 | 128 KB | 64 KB (4 pages) | Amstrad gate array | Beeper + AY-3-8912 | 3" floppy (uPD765A) + cassette | +3DOS v4.1 |

### ROM sets

All system ROMs are hosted; any page can be replaced from the ROM pane. A
non-UK locale falls back to the UK set when no ROM exists for it.

| Model | UK | Spanish (`es`) | French (`fr`) |
| --- | --- | --- | --- |
| 16K / 48K | `48.rom` | 48K only | — |
| 128K | `128-0/1.rom` | ✅ | ✅ |
| +2 | `plus2-0/1.rom` | ✅ | ✅ |
| +2A / +3 | `plus3-41-0…3.rom` | ✅ | — |

Dropping a raw ROM image picks the model by size: 16 KB → 48K, 32 KB → 128K,
64 KB → +2A (the current model is kept when it is already that class).

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| Z80A CPU | all | ✅ | Shared core [`src/cores/`](../../src/cores/); M1 refresh cycle never contended (per azesmbog) |
| Ferranti ULA | 16K, 48K, 128K, +2 | ✅ | Display, border, beeper, EAR/MIC, keyboard. Contention pattern 6,5,4,3,2,1,0,0 |
| Amstrad gate array | +2A, +3 | ✅ | Contention pattern 1,0,7,6,5,4,3,2; banks 4–7 contended |
| Memory contention | all | ✅ | 48K: 0x4000–0x7FFF. 128K/+2: odd banks. +2A/+3: banks 4–7 |
| Floating bus | all | ✅ | Ferranti: any unattached port. +2A/+3: only `0000 xxxx xxxx xx01` ports while paging is unlocked |
| 128K paging (7FFD) | 128K-class | ✅ | Bank, screen, ROM select, lock bit |
| +2A/+3 paging (1FFD) | +2A, +3 | ✅ | 4-page ROM select and the special RAM configurations |
| AY-3-8912 | 128K-class | ✅ | Stereo placement (ABC by default), ultrasonic filter, DC block, beeper/AY mix |
| Beeper / EAR / MIC | all | ✅ | Speaker level mixed from EAR and MIC like an Issue 3 board |
| Keyboard matrix | all | ✅ | Host keyboard mapping plus on-screen keyboards (rubber-key and +2/+3 legends) |
| Cassette interface | all | ✅ | Pulse-level playback; no recording (see Not emulated) |
| uPD765A FDC + 3" drives | +3 | ✅ | Drives A:/B:, weak-sector copies, protection-correct status bits |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Kempston joystick | Input | all | ✅ | Port `xxx0 0000`; physical gamepads and touch D-pad |
| Cursor / Sinclair 1 / Sinclair 2 joystick | Input | all | ✅ | Keyboard-mapped (Cursor also holds Caps Shift) |
| Kempston mouse | Input | all | ✅ | Ports FADF / FBDF / FFDF |
| AMX mouse | Input | all | ✅ | Z80 PIO with IM2 interrupts spread across the frame |
| Multiface 1 / 128 / 3 | ROM + RAM / NMI | 48K / 128K, +2 / +2A, +3 | ✅ | Variant picked by model; NMI button in the Hardware pane |
| ZX Interface 2 | Cartridge | 16K, 48K | ✅ | 16 KB ROM cartridge replaces the internal ROM; writes ignored |
| ZX Interface 1 + Microdrives | Storage | 48K, 128K, +2 | ◐ | Shadow ROM and up to 8 Microdrives work; RS-232 and ZX Net stubbed |
| MGT +D | Disk | 48K, 128K, +2 | ◐ | WD1772, G+DOS, drives C:/D:, read-write and format; printer port not implemented |
| Beta Disk (TR-DOS) | Disk | 48K, 128K, +2 | ✅ | WD1793, auto-paging at 0x3D00–0x3DFF, drives A:/B: |
| VTX-5000 | Viewdata modem | 48K | ◐ | 8 KB ROM and 8251 USART; no network connection behind it |

**Combination rules:** Interface 1, MGT +D and Beta Disk all overlay slot 0 and
cannot be fitted together; Beta Disk wins when more than one is enabled. The +D
is also excluded from the +2A/+3, which have their own FDC and a different
paging scheme.

---

## Media formats

ZIP archives are unpacked and their contents routed as below.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.szx` | Snapshot | Machine | ✅ | ✅ | Preferred save format |
| `.z80` | Snapshot | Machine | ✅ | ✅ | v1–v3 |
| `.sna` | Snapshot | Machine | ✅ | ✗ | 48K and 128K variants |
| `.sp` | Snapshot | Machine | ✅ | ✗ | |
| `.tap` | Tape | Tape deck | ✅ | ✗ | |
| `.tzx` / `.cdt` | Tape | Tape deck | ✅ | ✗ | Turbo and custom loaders at pulse level |
| `.csw` | Tape | Tape deck | ✅ | ✗ | Sampled tape |
| `.dsk` | Disk | +3 drives | ✅ | ✅ | Standard and extended DSK |
| `.hfe` | Disk | +3, +D, Beta | ✅ | ✅ | HFE v1 bitstream; only changed sectors rewritten, so protection is preserved |
| `.scp` | Disk | +3, +D, Beta | ✅ | ✗ | Flux images; weak sectors recovered from repeated revolutions |
| `.mgt` / `.img` | Disk | MGT +D | ✅ | ✅ | Saved as `.mgt` |
| `.trd` / `.scl` | Disk | Beta Disk | ✅ | ✅ | Saved in the same format it was loaded in |
| `.mdr` / `.mdv` | Microdrive cartridge | Interface 1 | ✅ | ✅ | Saved as `.mdr`, write-protect flag kept |
| `.rom` | Cartridge | Interface 2 | ✅ | — | 16K/48K only |

Blank disks can be created for the +3 (DSK or HFE), +D (800K MGT or HFE) and
Beta Disk.

**Save menu exports:** SZX snapshot, Z80 snapshot, PNG screenshot, `.scr`
screen dump, RAM `.bin`.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| T-state contention | ✅ | Per-model patterns and contended regions (see Built-in hardware) |
| Rainbow / multicolour rendering | ✅ | Three render modes: per-instruction mid-line, per-scanline, or once per frame (fastest) |
| Border size | ✅ | None / small (24px) / normal (48px) |
| Fast ROM loading | ✅ | Traps LD-BYTES when the 48K BASIC ROM is paged in; falls back to real-speed loading for anything that doesn't match |
| Turbo loading | ✅ | Runs the CPU flat out while a custom loader polls EAR |
| Tape sound | ✅ | |
| Loader detection | ✅ | Auto play/stop when the ROM or a loader starts or stops reading EAR |
| Media persistence | ✅ | Mounted tapes, disks and cartridges come back after a reload |
| Disk sounds | ✅ | Shared floppy sound model |
| Palettes and CRT effects | ✅ | Shared display layer, plus an attribute-mask option |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger | ✅ | Breakpoints, step into/over/out, run-to-cursor, Z80 disassembly, registers, memory views per ROM page and RAM bank |
| Trace | ✅ | Full execution, port I/O and ZXTrace; repeated loops coalesced |
| Screen OCR / TEXT overlay | ✅ | Reads the ROM character set or a custom font found in RAM |
| BASIC tools | ✅ | BASIC listing, BASIC variables, system-variables pane |
| Software library | ✅ | ZXDB-derived search with screenshots; picks the right model automatically |
| On-screen keyboard | ✅ | 48K rubber-key and +2/+3 layouts |
| MCP tools | ✅ | All generic tools, plus `multiface`, `vtx5000`, `plusd`, `betadisk`, `disk_trace`, `fdc_log`, `sector_read`, `track_geometry`, `disk_geometry`, `weak`, `frame_trace`, `reset_trap` |

---

## Known issues

None known.

## Not emulated

- **Tape recording.** `SAVE` drives MIC (you can hear it), but nothing captures it to a tape file.
- **Issue 2 keyboard behaviour.** Port FE bit 6 is modelled as an Issue 3 board, so software that relies on Issue 2 EAR/MIC feedback may misread keys.
- **Interface 1 RS-232 and ZX Net.** The ports are decoded but return idle-line values.
- **MGT +D printer port.** Reads 0xFF (never busy); writes are ignored.
- **uPD765A SCAN commands.** Unimplemented; the frame probe flags it when software issues one.
- **HFE v3** images are rejected with an error.
- **VTX-5000 network.** The modem has nothing connected to it.

## Faithful quirks

- **Arkanoid hangs on the +3.** It reads port 0xFF, which the gate array doesn't float, so the game never sees the value it waits for. Real +3s hang the same way.
- **16K upper RAM reads 0xFF.** Correct for an unexpanded Issue 1/2 16K.
- **Interface 2 cartridges ignore writes to 0x0000–0x3FFF.** The edge connector has no write line, just like the real slot.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| azesmbog ULA timing tests (48K, 128K, +3) | Pass | 2026-06-09 |
| Protected +3 disks (Speedlock, Alkatraz, Three-Inch Loader…) as HFE vs DSK | 38/47 byte-identical; the rest are corrupt dumps | 2026-07-14 |
| +3 HFE and SCP boots vs DSK boot | Framebuffer bit-identical | 2026-07-14 |
| Platoon, Barbarian II (+3 DDAM / CRC protections) | Load | 2026-06 |
| G+DOS (+D) and TR-DOS `CAT` | Working | 2026-07-14 |
