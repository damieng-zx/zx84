# Atari 8-bit

Atari's 8-bit home computer line: a 6502 with three custom chips — ANTIC
(display list processor), GTIA (colour, players/missiles, collisions) and POKEY
(sound, keyboard scan, serial) — plus a 6520 PIA. zx84 emulates the 400/800 and
the XL/XE machines, both TV standards, and runs the open-source AltirraOS and
Altirra BASIC in place of Atari's firmware.

| | |
| --- | --- |
| **Manufacturer** | Atari, Inc. |
| **Released** | 1979–1985 |
| **CPU** | MOS 6502 at 1.7897725 MHz (NTSC) / 1.773447 MHz (PAL); 6502C on the XL/XE boards |
| **zx84 kind** | `atari` — [`src/machines/atari/`](../../src/machines/atari/) |
| **Model ids** | `atari400` `atari800` `atari600xl` `atari800xl` `atari1200xl` `atari65xe` `atari800xe` `atari130xe` |
| **Accuracy** | scanline — each line is drawn with its mid-line register writes replayed (no accuracy selector) |
| **Status** | Working: boots to `READY`, BASIC, disk and cassette I/O, cartridges and `.xex` executables, snapshots. |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 400 (`atari400`) | 1979 | 16 KB | 10 KB OS | ANTIC + GTIA, 320×192 | POKEY + internal speaker | cassette, 810 disk, cartridge | membrane keyboard |
| 800 (`atari800`) | 1979 | 48 KB | 10 KB OS | ANTIC + GTIA | POKEY + internal speaker | cassette, 810 disk, cartridge | two cartridge slots on the real machine |
| 600XL (`atari600xl`) | 1983 | 16 KB | 16 KB XL OS | ANTIC + GTIA | POKEY | cassette, disk | BASIC in ROM |
| 800XL (`atari800xl`) | 1983 | 64 KB | 16 KB XL OS | ANTIC + GTIA | POKEY | cassette, disk | BASIC in ROM; the default model |
| 1200XL (`atari1200xl`) | 1982 | 64 KB | 16 KB 1200XL OS | ANTIC + GTIA | POKEY | cassette, disk, cartridge | no built-in BASIC |
| 65XE (`atari65xe`) | 1985 | 64 KB | 16 KB XL/XE OS | ANTIC + GTIA | POKEY | cassette, disk | BASIC in ROM |
| 800XE (`atari800xe`) | 1985 | 64 KB | 16 KB XL/XE OS | ANTIC + GTIA | POKEY | cassette, disk | BASIC in ROM |
| 130XE (`atari130xe`) | 1985 | 128 KB | 16 KB XL/XE OS | ANTIC + GTIA | POKEY | cassette, disk | 4 × 16 KB banked extended RAM |

The TV standard is a **locale**, not a model: every machine was sold in NTSC
and PAL form with the same logic and a different crystal, scanline count and
GTIA. `'us'` builds the NTSC machine, every other locale the PAL one, and the
same OS image serves both — the machine tells PAL from NTSC through GTIA, as
the real hardware does.

### ROM sets

| Model | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| 400, 800 | both | 10 KB OS | AltirraOS 3.44 (400/800 build) at `atari/altirraos-800.rom` |
| 600XL, 800XL, 65XE, 800XE, 130XE | both | 16 KB XL OS | AltirraOS 3.44 (XL/XE build) at `atari/altirraos-xl.rom` |
| 1200XL | both | 16 KB XL OS | as above |
| XL/XE with built-in BASIC | both | + 8 KB BASIC | Altirra BASIC 1.59 at `atari/altirra-basic.rom` |
| 400, 800, 1200XL | both | BASIC is a cartridge | the same 8 KB image, hidden-mounted when the slot is empty |

The default firmware is **open source** — AltirraOS, Avery Lee's clean-room OS,
and Altirra BASIC, an 8K drop-in for Atari BASIC — so the emulator ships no
Atari ROMs. Atari's own images still work when supplied through the ROM pane or
the cartridge slot. A 10 KB drop is recognised as a 400/800 OS and a 16 KB one
as an XL OS; an 8 KB drop is a BASIC cartridge, so it goes to the media path
rather than being installed as firmware.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| MOS 6502 / 6502C | all | ✅ | 114 cycles per scanline; 262 lines NTSC, 312 PAL, 240 displayed in both |
| ANTIC | all | ✅ | display lists, playfield modes 2–F, players/missiles DMA, vertical scroll, cycle stealing from the CPU |
| GTIA | all | ✅ | colour and luminance, players/missiles, priorities, collisions, CONSOL, the PAL pin, the 400/800's internal speaker |
| POKEY | all | ✅ | four sound channels, keyboard scan, serial and SIO, pot counters, random numbers |
| 6520 PIA | all | ✅ | two joysticks on port A and the GTIA triggers; on the XLs port B is the memory-control register |
| Keyboard | all | ✅ | scanned by POKEY, with the 400's membrane deck and the XL/XE full-travel deck on screen |
| Cassette (410/1010) | all | ✅ | `.cas` played at signal level (custom loaders see it) and at record level for instant `CLOAD`; `CSAVE` is recorded |
| SIO bus | all | ✅ | disk drives D1:–D4: with selectable models, and the program recorder |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Cartridge slot | ROM | all | ✅ | 4K (mirrored), 8K and 16K images |
| 810, 1050, XF551, SIO2PC drives | disk | all | ✅ | D1:–D4:, each with its own model; SIO2PC (any image) is the default |
| CX40 joysticks | input | all | ✅ | two ports, one fire button each; keys and gamepads drive the same lines |

**Combination rules:** on the models with BASIC in ROM, BASIC is part of the
system image. On the 400/800/1200XL it is a cartridge: the shell hidden-mounts
Altirra BASIC when the slot is empty, so the machine still comes up with BASIC,
and a mounted cartridge replaces it.

---

## Media formats

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.atr` | disk | D1:–D4: | ✅ | ✅ | ATR container with its per-sector status; any image size up to hard-disk |
| `.xfd` | disk | D1:–D4: | ✅ | ✅ | raw sector dump; written back as ATR |
| `.cas` | tape | program recorder | ✅ | ✅ | FUJI blocks, including `fsk ` level blocks; what `CSAVE` writes since reset |
| `.xex`, `.com` | executable | autostart | ✅ | — | armed and run at the OS's load point, then cleared by a real boot disk |
| `.rom`, `.car`, `.bin` | cartridge | slot | ✅ | — | 4K/8K/16K images |
| `.a8state` | snapshot | native state | ✅ | ✅ | zx84's own format; no other emulator's snapshots are read |
| `.zip` | archive | per member | ✅ | — | entries matching the above are offered |

**Save menu exports:** `.a8state` snapshot, `.cas` tape (`tape-tap`), PNG
screenshot, RAM dump.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| ANTIC cycle stealing | ✅ | refresh, display-list, playfield and player/missile DMA are charged, so the CPU's effective clock drops the way it does on hardware |
| Mid-line register writes | ✅ | colour, character-set and display-list changes take effect from the cycle they land on, not from the next line |
| GTIA modes | ✅ | the ten special modes, over the hi-res ANTIC modes |
| Region palettes | ✅ | NTSC and PAL GTIA colour tables, chosen from the model's locale |
| Drive models | ✅ | the Drives pane fits 810 / 1050 / XF551 / SIO2PC per drive; a disk the model cannot read mounts and then fails as error 144 |
| Autostart | ✅ | reads the DOS directory or the first tape record and types what a person would — boot with or without BASIC, `RUN "D:NAME.BAS"`, `CLOAD` + `RUN`, or hold START for a boot tape; every wait has a limit, so a plan that misses its prompt is dropped quietly |
| BASIC listing and variables | ✅ | read from Atari BASIC's tables when BASIC is resident |
| Screen OCR / TEXT overlay | ✅ | the 40×24 GRAPHICS 0 grid, through the OS's own character set |
| On-screen keyboard | ✅ | the 400's membrane deck and the XL/XE full-travel deck |
| Snapshots | ✅ | `.a8state` carries RAM, banked extended RAM, the custom chips and the media |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | shared 6502 debug service |
| Trace | ✅ | `full`, `portio` |
| Screen OCR / TEXT overlay | ◐ | text modes only; graphics screens have no text to transcribe |
| Software library | ✗ | no Atari catalogue |
| Machine-specific panes | ✅ | Banks pane (the memory map is real), BASIC listing and variables, Drive pane with per-drive models, on-screen keyboard |
| MCP tools | ✅ | the generic 6502 tools, plus the ROM-region and memory views |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| No screen dump | all | low | the Save menu offers a PNG screenshot but not the machine's own screen format |
| OCR is text-only | all | low | the overlay covers the 40×24 GRAPHICS 0 grid; graphics modes are not transcribed |
| Cassette is `.cas` only | all | low | `.wav`/`.csw` recordings are not accepted, and saving writes `.cas` |
| Frame-level convenience paths | all | low | the Display pane offers no accuracy selector; the renderer is always the scanline one |

## Not emulated

- **Printer and plotter output** — the 820/1020 and the printer handlers behind
  them are absent, so nothing is captured for the Save menu.
- **Mouse and trackball** — the machine has no mouse interface declared; the
  joystick ports take sticks only.
- **Second cartridge slot of the 800** — one slot is modelled.

## Faithful quirks

- **The TV standard is the machine, not the ROM.** PAL and NTSC are the same
  logic and the same OS image; GTIA's PAL pin is what software reads to tell
  them apart.
- **BASIC is firmware on some models and a cartridge on others.** The
  400/800/1200XL boot it from the slot; the 600XL/800XL/XE have it in ROM.
- **RAM under the ROMs.** On the XLs, PIA port B is a memory-control register:
  the OS can uncover RAM beneath the OS and BASIC ROMs.
- **The 130XE's extended RAM is windowed, not paged.** Its four 16K banks are
  mapped over `$4000-$7FFF` for the CPU, ANTIC or both, chosen in the same
  control register.
- **A disk the drive cannot read still mounts.** The drive answers and then
  fails with device error 144 rather than timing out, which is why the mount
  message names the model the image needs.
- **The cassette has two readers.** The OS loads a record whole through SIOV
  (instant `CLOAD`), while custom loaders sample the signal level; both share
  one tape position, so a loader that gives up mid-file leaves the tape where a
  real recorder would have.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| `tests/atari/altirra-boot.test.ts`, `atari-boot.test.ts` | boots the hosted AltirraOS to `READY` and runs `PRINT` in BASIC | 2026-11-22 |
| `tests/atari/antic.test.ts`, `gtia.test.ts`, `video.test.ts`, `mid-line.test.ts`, `palette.test.ts` | playfield modes, players/missiles, GTIA special modes, mid-line writes, region palettes | 2026-11-22 |
| `tests/atari/pokey.test.ts`, `pia.test.ts`, `keyboard.test.ts` | sound channels, joystick/trigger lines, keyboard scan | 2026-11-22 |
| `tests/atari/atr.test.ts`, `xfd`, `disks.test.ts`, `sio.test.ts`, `sio-bus.test.ts`, `ocean-drive.test.ts` | ATR/XFD geometry, drive models and the SIO fast path | 2026-11-22 |
| `tests/atari/cassette.test.ts`, `cassette-signal.test.ts` | record-level `CLOAD`, signal-level custom loaders, `CSAVE` | 2026-11-22 |
| `tests/atari/xex.test.ts`, `autostart.test.ts`, `roms.test.ts` | `.xex` arming, cold-start autostart, ROM sockets and cartridge handling | 2026-11-22 |
| `tests/atari/basic.test.ts`, `ocr.test.ts`, `snapshot.test.ts`, `memory.test.ts`, `xl.test.ts`, `peek.test.ts`, `machine.test.ts` | BASIC tables, OCR grid, `.a8state` round trip, XL banking, registration | 2026-11-22 |
