# Acorn Electron

Acorn's low-cost 6502 home computer, in which one custom chip (the ULA) does the work of the BBC Micro's video, sound, cassette, keyboard and ROM-paging hardware. zx84 emulates the base machine and the Plus 1 (cartridge slots, analogue and printer ports) and Plus 3 (WD1770 disc interface) expansions as Hardware-pane options.

| | |
| --- | --- |
| **Manufacturer** | Acorn Computers |
| **Released** | 1983 |
| **CPU** | MOS 6502 — 2 MHz for ROM; RAM, FRED and JIM accesses run at 1 MHz |
| **zx84 kind** | `electron` — [`src/machines/electron/`](../../src/machines/electron/) |
| **Model ids** | `electron` — the MCP `model` target and `?model=` value (the URL value is case-insensitive: `?model=Electron` works) |
| **Accuracy** | Display pane Accuracy (High / Mid / Low, shared with the BBC Micro and Apple II). High draws the picture as the beam goes, to 8 pixels, so a mode, palette or screen-memory write shows from the pixel the beam had reached; Mid draws each 128-cycle scanline as it ends; Low draws the whole frame at its end. CPU timing is the same at all three, and RAM-access timing is modelled |
| **Status** | Boots the real OS and BASIC, loads and saves cassettes, and runs the Plus 1 and Plus 3 (ADFS or DFS) with their real ROMs |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Electron (`electron`) | 1983 | 32 KB | 32 KB (16 KB BASIC + 16 KB OS) | ULA, modes 0–6 | 1-bit beeper | Cassette (1200 baud); Plus 3 discs optional | 312 lines × 128 cycles = 39,936 cycles per frame (50.08 Hz) |

Display modes (the ULA treats mode 7 as mode 6):

| Mode | Resolution | Colours per pixel | Text grid | Screen memory |
| --- | --- | --- | --- | --- |
| 0 | 640 × 256 | 1 bit (2 colours) | 80 × 32 | 20 KB |
| 1 | 320 × 256 | 2 bits (4 colours) | 40 × 32 | 20 KB |
| 2 | 160 × 256 | 4 bits (8 colours) | 20 × 32 | 20 KB |
| 3 | 640 × 250 | 1 bit | 80 × 25 (gapped rows) | 16 KB |
| 4 | 320 × 256 | 1 bit | 40 × 32 | 10 KB |
| 5 | 160 × 256 | 2 bits | 20 × 32 | 10 KB |
| 6 | 320 × 250 | 1 bit | 40 × 25 (gapped rows) | 8 KB |

### ROM sets

The system ROM and expansion ROMs are fetched from the ROM host on demand. There is one set; the model has no locale variants.

| Part | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| System ROM: `electron/basic.rom` (16 KB) + `electron/os.rom` (16 KB) | — | BASIC in pages 10 and 11, OS at `&C000` | hosted |
| Plus 1 expansion OS: `electron/plus1.rom` (8 KB, repeated to fill the 16 KB window) | — | 12 | hosted |
| Plus 3 ADFS: `electron/plus3.rom` (16 KB) | — | 4 | hosted |
| Plus 3 ACP 1770 DFS: `electron/dfs.rom` (16 KB) | — | 0 | hosted |
| Cartridges, sideways and user ROMs | — | 0–7, 12–15 (see Peripherals) | user-supplied |

The ROM pane replaces the system ROM with a 32 KB image (BASIC then OS; anything shorter is refused) and loads 16 KB images into the sideways pages 0–7 and 12–15. An image smaller than 16 KB repeats to fill its window. A ROM supplied by an expansion wins over a user ROM in the same page.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| 6502 CPU | all | ✅ | Shared core [`src/cores/m6502.ts`](../../src/cores/m6502.ts) |
| ULA (Ferranti 12C021) | all | ✅ | [`electron-ula.ts`](../../src/machines/electron/electron-ula.ts): 16 registers at `&FE00`–`&FE0F`, repeating through `&FExx` |
| ULA — video | all | ✅ | Modes 0–6 drawn from a latched screen start (`&FE02`/`&FE03`) at the chosen accuracy (see Emulation features); 8-colour palette (`&FE08`–`&FE0F`, written value inverted); black border |
| ULA — interrupts | all | ✅ | Power-on reset, display end (end of line 256, or 250 in modes 3 and 6), 50 Hz real-time clock (line 100), receive full, transmit empty, high tone; cleared through `&FE05` bits 4–6 |
| ULA — RAM arbitration | all | ✅ | In modes 0–3 a RAM access waits for the display fetch (first 80 cycles of each picture line); modes 4–6 never wait. Any RAM access drops to the 1 MHz clock |
| ULA — ROM paging | all | ✅ | Low nibble of `&FE05` selects one of 16 ROM windows at `&8000`–`&BFFF`; pages 8 and 9 read the keyboard, 10 and 11 are BASIC |
| ULA — keyboard | all | ✅ | 14 × 4 matrix read through pages 8/9; the pressed bits of every column whose address line is low appear in D0–D3 |
| ULA — sound | all | ✅ | 1-bit speaker toggled every 32 × (divider + 1) cycles (`&FE06`) in sound mode |
| ULA — cassette | all | ✅ | Motor, caps-lock lamp and comms mode in `&FE07`; 1200 baud 8N1 receive and transmit through `&FE04`; high-tone detect |
| RAM | all | ✅ | 32 KB at `&0000`–`&7FFF`, shown as two 16 KB banks in the debugger |
| System ROM | all | ✅ | BASIC (16 KB) and OS at `&C000`–`&FBFF` and `&FF00`–`&FFFF`; writes are ignored |
| FRED / JIM | all | ◐ | FRED (`&FC00`–`&FCFF`) is decoded for the fitted expansions. JIM (`&FD00`–`&FDFF`) is absent and floats high. Unmapped addresses read `&FF` |
| Keyboard | all | ✅ | See Emulation features |
| Cassette interface | all | ✅ | Pulse-level playback of UEF and CSW; recording of what the OS SAVEs |
| Disk controller | — | — | None built in; supplied by the Plus 3 |

---

## Peripherals

Fitted from the Hardware pane. Each option loads its ROM at build time, so toggling one rebuilds the machine.

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Plus 1 (cartridges) — Hardware pane option "Plus 1 (cartridges)" | ROM / input / comms | `electron` | ◐ | Expansion OS in ROM 12 and the front cartridge slot (SK1, ROM pages 2 and 3). ADC0844 at `&FC70`, printer data at `&FC71`, status at `&FC72` |
| Plus 1 printer port | comms | `electron` | ✅ | A write to `&FC71` latches and strobes a byte and raises BUSY (status bit 7, `&FC72`) for 50 µs (100 cycles; a stand-in for a fast printer, since the real time belongs to the printer). The Plus 1 ROM's driver polls bit 7 before each byte, so a printer held busy holds the text back. The bytes (up to 64 KB) are kept and offered from the Save menu as "Printer output (.txt)" (`electron-printer.txt`, raw bytes: `VDU 2 : PRINT "HELLO"` after `*FX5,1` gives `HELLO` and a carriage return, the OS's default ignoring line feeds). No ACK line or printer interrupt |
| Plus 1 analogue joysticks | input | `electron` | ✅ | Shown while the Plus 1 is fitted. A write to `&FC70` selects the channel (the Plus 1 ROM writes 4–7 for ADVAL(1)–(4)) and starts a 40 µs conversion; status bit 6 (/INTR) goes low when it ends and high again when `&FC70` is read. Player 1 is channels 1/2 and fire on status bit 4, player 2 channels 3/4 and bit 5 (fire buttons low while pressed). Sticks read 255 at full left and full up, as on the BBC Micro; keys give full deflection, a gamepad's analogue stick is proportional |
| Plus 3 (disc drives) — "Plus 3 (disc drives)" | Disk | `electron` | ✅ | WD1770 at `&FCC4`–`&FCC7` with the drive-control latch at `&FCC0` (drive 0/1, side, density, controller reset; bit 3 selects single density, and a track recorded in the other density reads as unformatted); ADFS ROM in page 4; two drives. DRQ and command completion raise the CPU NMI, and ADFS moves each byte from its NMI handler |
| Plus 3 with ACP 1770 DFS — "DFS instead of ADFS (.ssd/.dsd)" | Disk | `electron` | ◐ | Swaps the ADFS ROM for the ACP 1770 DFS (fitted as ROM 0) on the same WD1770 interface, so Acorn DFS discs work. Only enabled while the Plus 3 is fitted. See Known issues |
| Sideways ROM sockets | ROM | `electron` | ✅ | ROM pane lists pages 0 and 1 (socket SK2), 2 and 3 (SK1), 4 (disc interface), 5 and 6 (user ROM), 7 (modem interface), 12 (Plus 1 OS), 13 (high priority), 14 (Econet), 15 (reserved); pages 8–11 are not sockets. Loaded ROMs persist across reloads |

**Combination rules:** The DFS option needs the Plus 3 and replaces its ADFS ROM; the two filing systems are never fitted together. Removing the Plus 1 ejects any cartridge; removing the Plus 3 ejects both discs. Drives appear in the Drives pane and cartridges in the ROM pane only while the matching expansion is fitted.

---

## Media formats

ZIP archives are unpacked and only entries the machine accepts are offered. Media is routed by what is fitted: `.adf`/`.adl`/`.ads`/`.adm` need the Plus 3 in ADFS mode, `.ssd`/`.dsd` need the Plus 3 in DFS mode, and `.rom` needs the Plus 1; otherwise the mount fails with a message naming the option to fit. `.img`, `.dsk`, `.hfe` and `.scp` discs are taken in either mode and told apart by content (an ADFS root directory or a DFS catalogue in a sector dump; ten single-density or sixteen double-density sectors on the first track of an HFE or SCP); a disc that is plainly the other filing system's is refused, one that is neither (a protection first track) is mounted. HFE and SCP are recognised by their signature whatever the file is called.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.uef` | Tape | Tape deck | ✅ | ✅ | Plain or gzip-wrapped; the content decides, not the name. Save is a recording of what the OS SAVEs to the cassette port (always named `electron-tape.uef`), not a re-save of the mounted tape |
| `.csw` | Tape | Tape deck | ✅ | ✗ | Sampled tape |
| `.elkstate` | Snapshot | Machine | ✅ | ✅ | zx84's own exact save state (see below) |
| `.adf` `.ads` `.adm` | Disk (ADFS) | Plus 3 drive 0 / 1 | ✅ | ✅ | Raw 16 × 256-byte sector dumps. Geometry by size: up to 160 KB is 40 tracks single-sided (S), up to 320 KB is 80 tracks single-sided (M), larger is 80 tracks double-sided (L). Short files are padded; images over 640 KB are refused |
| `.adl` | Disk (ADFS L) | Plus 3 drive 0 / 1 | ✅ | ✅ | Always 80 tracks double-sided, even if trimmed. The image holds the cylinders in turn, side 0 then side 1 of each (the BeebEm, MAME and Greaseweazle convention); ADFS itself fills side 0 before side 1, so logical sector 16 is image sector 32 |
| `.img` `.dsk` | Disk (ADFS or DFS) | Plus 3 drive 0 / 1 | ✅ | ✅ | Headerless sector dump of either filing system, by content; one that says neither is taken as the filing system the Plus 3 is set to. Saved back as the matching ADFS or DFS dump |
| `.hfe` | Disk | Plus 3 drive 0 / 1 | ✅ | ✅ | HFE v1 or v3 bitstream, decoded track by track: MFM for ADFS, FM for DFS. Deleted-data marks, CRC errors, odd sector IDs and sizes and duplicate IDs are kept; v3 weak bytes become weak sectors. Saved back as `.hfe` (v1), only written sectors re-encoded |
| `.scp` | Disk | Plus 3 drive 0 / 1 | ✅ | ◐ | SuperCard Pro flux, decoded at load; a sector that reads differently across revolutions is weak. Saved as an ADFS or DFS dump when its layout is plain, otherwise as `.hfe` |
| `.ssd` `.dsd` | Disk (Acorn DFS) | Plus 3 drive 0 / 1 (DFS mode) | ✅ | ✅ | 10 × 256-byte sectors per track; `.dsd` interleaves the two sides. Truncated images are padded to the 40 or 80 tracks their catalogue declares |
| `.rom` | Cartridge | Plus 1 front slot | ✅ | — | 16 KB (repeated into both banks) or 32 KB (lower then upper bank). `Name_1.rom` + `Name_2.rom` halves are joined into one 32 KB cartridge in either order when the first is still in the slot |

Drive 0 is the default target and drive 1 is selected with target `b`. Mounting a disc in drive 0 or a cartridge boots it with SHIFT+BREAK (cartridge insert and eject also power-cycle the machine first); mounting a tape does not reset the machine and the status line says to type `CHAIN""` (or `*RUN`).

Disc saves from the Drives pane keep the format family: ADFS discs save as `.adl` (two-sided), `.adm` (more than 40 tracks) or `.ads`, so a loaded `.adf` is saved under the extension matching its geometry; DFS discs save as `.dsd` or `.ssd`. A disc that came from an HFE saves as `.hfe`, as does any disc whose layout a sector dump cannot hold (a protection track, deleted-data or bad-CRC sectors). The Drives pane can create blank ADFS discs (640 KB L, 320 KB M, 160 KB S; unformatted as far as the filing system is concerned, so `*FORMAT` is still needed) or, in DFS mode, blank DFS discs (100 KB, 200 KB single-sided; 200 KB, 400 KB double-sided). Write-protect can be set per drive.

**Snapshots.** `.elkstate` is zx84's native save state, in the same container as the Atari's `.a8state` (a CRC-32 and length checked before the machine is touched, deflated when saved from the Save menu), magic
`ZXEL`: the 6502, the 32 KB of RAM and the ROM page, the ULA (interrupt
status and mask, screen address counters, mode, palette, sound counter, the
cassette shifters with a byte half received or held for sending), the cassette
relay, tone demodulator and recording, the Plus 1 (ADC with a conversion in
progress, the joysticks as held, the printer output and when its BUSY ends) and a cartridge in its
slot, the Plus 3's latch and WD1770 down to a transfer in flight, and the
beam's frame grid. A file saved from the Save menu also carries the discs
(writes included) and the tape with the deck's position to the cycle. The
header records the CRCs of BASIC, the OS and the paged ROMs (a mismatch loads
with a warning); a state saved with other expansions or another drive count is
refused until the Hardware or Drives pane matches. A state is taken between
frames and restores cycle for cycle. The same state without the discs and tape
backs browser-refresh resume (the shell remounts the discs without a
SHIFT+BREAK or a head move).

**Save menu exports:** Snapshot `.elkstate`, Saved tape (`.uef`), Printer output (`.txt`, the Plus 1 printer port's bytes; "Nothing has been sent to the printer yet" while there are none or the Plus 1 is not fitted), PNG screenshot, RAM `.bin` (the 32 KB of main RAM).

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Memory timing | ✅ | ROM at 2 MHz; RAM, FRED/JIM and the keyboard pages at 1 MHz (one or two extra cycles to align with the slow clock); display-fetch halt in modes 0–3 |
| Video accuracy | ✅ | Display pane Accuracy. **High** (default) catches the line in progress up to the beam (8 pixels a cycle across the 80-cycle display window) before every CPU write to RAM, the mode register (`&FE07`) or a palette register (`&FE08`–`&FE0F`), so a raster split made from the line-100 clock interrupt shows from the pixel it landed on. The write's cycle is worked out from the instruction (as on the BBC Micro) and is good to a couple of cycles (a handful of pixels); in modes 0–3 a RAM access waits out the display fetch, so a write to RAM lands after the line's pixels have gone out and shows from the next line. **Mid** draws each scanline whole as it ends, with the state as it is then. **Low** draws the 256 lines at the end of the frame with the mode and palette as they are then (a mid-frame change shows over the whole frame, and one set back at display end not at all); the screen address of each line is still tracked line by line, so timing is the same. Turbo draws at Low. A still picture is identical at all three, in every mode |
| Border size | ✅ | The border is always black and fully rendered; the setting crops it (none / small / normal) |
| Pixel aspect | ✅ | The 640-pixel modes are shown at half width (1× = 384 × 288) |
| Palette | ✅ | PAL (saturated) or Measured (muted) colour map, shared with the BBC Micro setting |
| Cassette at pulse level | ✅ | UEF and CSW are played as pulses and decoded by the ULA's own receiver; the tape moves only while the ULA motor bit is set |
| Tape recording | ✅ | Bytes the OS transmits are recorded and offered as a UEF from the Save menu |
| Tape turbo loading | ✅ | The CPU runs flat out while the tape is being read (setting `tape-turbo-load`, on by default), with a cool-down after the tape stops being consumed |
| Fast ROM loading | ✗ | No ROM trap; loading is real-speed or tape turbo |
| Tape sound | ✗ | The descriptor declares no loading sound; the speaker is silent in cassette mode |
| Keyboard | ✅ | Typed characters are routed by the character produced, so a PC keyboard produces the Electron's own symbols (`"` is SHIFT+2, `@` is SHIFT+0, `*` is SHIFT+`:`; `^ _ £ \| [` and `~ } { \ ]` are SHIFT/CTRL on the cursor and COPY keys). Letters follow caps lock. Host SHIFT is passed only to non-character keys. F1–F10 are FUNC + 1–9, 0; Tab is FUNC; CapsLock acts as the CTRL key; End, Home and Insert are COPY |
| BREAK and SHIFT+BREAK | ✅ | Pause or F12 is BREAK (resets the CPU and ULA modes, keeps RAM and does not flag a cold start); with SHIFT held it also holds SHIFT for 25 frames so a disc's `!BOOT` or a cartridge runs |
| Power-on reset | ✅ | The ULA flags a cold start so the OS clears memory and shows its banner |
| Disk activity and sounds | ✅ | Drive LEDs with track, sector and dirty flags; shared floppy sound model |
| Media persistence | ✅ | Mounted tapes and discs come back after a reload |
| Palettes and CRT effects | ✅ | Shared display layer |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | 6502 registers, disassembly, step into/over/out, PC breakpoints and traps. Memory views cover the two 16 KB RAM banks. Memory watchpoints (read, write or either) stop the frame after the accessing instruction; there are no port watchpoints because the machine has no I/O port space |
| Trace | ✅ | Full (address, disassembly, registers, cycles and operand context, with interrupt entries marked and tight loops folded) and an I/O tally of the CPU's reads and writes in FC00-FEFF (FRED, JIM and the ULA) — the shared 6502 trace engine; no ZXTrace, which is a Z80 layout; a trace stops capturing at 500,000 lines |
| Screen OCR / TEXT overlay | ✅ | Matches the 8 × 8 glyphs in every mode against the OS font found in the OS ROM, in normal and inverse video, with paper and ink colours; the MCP `ocr` tool returns the text |
| BASIC tools | ✅ | BASIC listing and BASIC variables panes read the tokenised program from `PAGE` |
| Software library | ✗ | Not offered |
| Machine-specific panes | ✅ | Hardware-pane section (Plus 1, Plus 3, DFS); on-screen Electron keyboard with BREAK, cassette-motor and caps-lock lamps; Tape, Drives (Plus 3 only) and ROM panes. The Joysticks pane appears while the Plus 1 is fitted. Hidden: microdrive, mouse, system variables, font and banks panes |
| MCP tools | ◐ | The generic tools: `model`, `run`, `step_frame`, `step`, `registers`, `set_register`, `read_memory`, `write_memory`, `find`, `disassemble`, `breakpoint` and its delete, `memory_watchpoint` and its delete, `trap` family, `reset_trap`, `key`, `type`, `load`, `eject`, `screenshot`, `ocr`, `symbols`, `symbols_load`. No Electron-specific tool exists, and the MCP has no way to fit the Plus 1, Plus 3 or DFS (they default to off), so `.adf`/`.adl`/`.ssd`/`.rom` loads are refused there; tapes load. `trace` and `stop_trace` work in full and portio modes, and `save` writes Spectrum snapshots only |
| Drive count | ✅ | Plus 3 drives: one or two. Pick **Drive count** in drive 0's options menu in the Drives pane. The choice is saved, rebuilds the machine, and with one drive the WD1770 sees nothing on the second select line (seek error, not ready) |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| Discs made for a Pegasus-style DFS fail on the ACP 1770 DFS | Plus 3 in DFS mode | medium | 28 of the 117 discs in the Electron `.ssd` collection show disc errors ("Sector not found at :3", "File not found", "Channel", then "Bad program") when booted with SHIFT+BREAK. The ACP 1770 DFS keeps its catalogue at `&0E00`–`&0FFF` and its other workspace up to `&18FF` in main RAM (`PAGE` `&1900`) and trusts what it holds there between calls, as on a real Plus 3. Those discs were mastered for the Slogger Pegasus 400, whose DFS keeps its workspace in RAM on the interface and moves data by polling, so `PAGE` stays at `&E00` and the titles use `&0D00`–`&18FF` freely. Traced examples: Frak! and Guardian `CHAIN` their loader with `PAGE=&E00`, then `*LOAD` from it; Adventure loads `ADV2` to `&0F00` and the next `*LOAD` reads track and sector numbers out of it ("Sector not found at :3 0F/07"); Hostages assembles code at `&1000`; Killer Gorilla loads a file at `&0D00`, over the DFS's own transfer code. Of the 28, 24 have a code or data file catalogued over that range (so do 60 of the 89 that run, which mostly stop using the disc first), and 4 (Gunfighter, Snapper, Joe Blade 2, Shanghai Warriors) show nothing of the kind and are unexplained. Fixing this needs a Pegasus 400 model (a 16 KB DFS ROM page whose top 2 KB is RAM, the same WD1770 registers at `&FCC0`/`&FCC4`, DRQ to NMI switched by latch bit 4) running the Pegasus DFS ROM, which is not available here; combining the ACP ROM with private RAM would be hardware that never existed, so neither is built. Evidence: the Pegasus 400 reviews (PAGE kept at `&E00`), MAME's `peg400` description of the board, and the traces above |

## Not emulated

- **ADC conversion noise.** A Plus 1 conversion returns the stick's position exactly; a real ADC0844 jitters in its low bit.
- **Second Plus 1 cartridge slot.** Only the front slot (ROM pages 2 and 3) takes cartridges as such. A ROM in pages 0 and 1 (the second slot's pages) loads from the ROM pane as a sideways ROM and behaves the same on the bus; what is not built is a second cartridge slot in the ROM pane and the Load menu. Page 0 is also where the ACP DFS lives, so the two would compete.
- **JIM paged memory.** `&FD00`–`&FDFF` is absent and floats high. The Plus 1 and Plus 3 have no paged RAM of their own; the register that selects the 256-byte page belongs to third-party RAM boards, each with its own decode, and none is documented well enough here to build.
- **Pegasus-style disc interfaces.** The Slogger Pegasus 400 (and similar) keeps the DFS workspace in RAM on the interface and moves data by polling, so PAGE stays at `&E00`; discs mastered for it are the Known issue above.
- **Other expansion hardware.** Econet, modem and other interfaces exist only as empty ROM pages; nothing decodes their registers.
- **UEF disc-image chunks.** UEF chunks outside the tape set (disc images `&0200`–`&02xx`, ROM images, machine hints) are skipped; a UEF that yields no tape blocks is refused as unreadable. Chunk `&0115` (phase change) is read and has no effect: the receiver times each half-cycle whichever way up it is.
- **Track timing on HFE and SCP discs.** Tracks are decoded to sectors once at load. Deleted-data marks, CRC errors, odd sector IDs and sizes, duplicate IDs and weak sectors carry over, but protections that time the track itself (gap lengths, where a sector sits relative to the index) are not reproduced.
- **Snapshots from other emulators.** Only zx84's own `.elkstate` (not
  ElectrEm's or Elkulator's states). Keys held on the host are not part of a
  state, and a disc transfer in flight when a refresh copy is taken loses its
  place.

## Faithful quirks

- **Page register restriction.** A write to `&FE05` that does not set bit 3 is ignored while ROM page 8–11 is selected, so software can only leave the BASIC/keyboard group for the upper half (pages 8–15).
- **BASIC mirrored in pages 10 and 11.** Both select the BASIC ROM; empty pages read `&FF`.
- **Small ROMs repeat.** A ROM smaller than 16 KB has its upper address lines unconnected, so it repeats across the window.
- **Palette registers are inverted.** `&FF` written to a palette register gives black and `&00` gives white.
- **Mode 7 is mode 6.** The ULA has no mode 7 of its own and displays it as mode 6.
- **Reading `&FE00` clears the power-on-reset flag.** The first status read after power-on sees it; after BREAK it is not set, which is how the OS tells a cold start from a warm one.
- **Cartridge and system ROMs ignore writes.**
- **Type-ahead is lost during disc access.** The boot test records that the OS reads no keys while it owns the disc controller, so keys typed during a catalogue or load do not arrive.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| [`tests/snapshot/electron-state.test.ts`](../../tests/snapshot/electron-state.test.ts) | `.elkstate`: synthetic firmware with a Plus 3 multi-sector read, the Plus 1 ADC with sticks held, the tape, ULA interrupts and sound in flight; a restored machine matches the original frame for frame (registers, cycles, picture, whole state); cartridge carried; damaged files and other expansions refused untouched; refresh resume with the disc remounted and no SHIFT+BREAK; a BASIC program on the real OS (skipped when the cached ROMs are absent) | Test file in repo |
| [`tests/electron.test.ts`](../../tests/electron.test.ts) | Memory map and ROM paging, keyboard matrix and host mapping, BREAK, ULA interrupts, palette and display for modes 0–6 (including mid-frame palette change and gapped modes), memory timing (2 MHz ROM, 1 MHz RAM, display-fetch halt in modes 0–3 only), sound divider, cassette receive and transmit, services, sideways ROM listing | Test file in repo |
| [`tests/electron-expansions.test.ts`](../../tests/electron-expansions.test.ts) | Plus 1 (ROM 12, cartridge banks, `_1`/`_2` pairing, status registers, SHIFT+BREAK boot), Plus 3 (WD1770 registers, DRQ per byte, NMI on completion, drive/side latch, controller driven from the CPU clock, `.adl` save), DFS swap (ROM 0, `.ssd`/`.dsd` accept, formatted track length) | Test file in repo |
| [`tests/electron-joystick.test.ts`](../../tests/electron-joystick.test.ts) | Plus 1 ADC0844: 40 µs conversion, /INTR on status bit 6, result latch, channel and fire-button wiring, proportional input, no joystick without the Plus 1; ADVAL(0), (1), (2) and (4) through the real Plus 1 Expansion ROM (skipped when the cached ROMs are absent) | Test file in repo |
| [`tests/electron-video-accuracy.test.ts`](../../tests/electron-video-accuracy.test.ts) | Hand-assembled raster split from the line-100 clock interrupt: at High the palette write shows from the pixel the beam had reached (8 pixels a cycle; mode 4), from the next line in mode 0 where the stack push waits out the display fetch; at Mid from the start of its line; at Low the frame has the palette as at its end. A mode 4 screen-memory write behind the beam keeps the old byte, one ahead shows the new. A still screen is identical at High, Mid and Low in modes 0–6 (random memory, palette writes splitting every line) and on the real OS's BASIC screen (skipped when the cached ROMs are absent) | Test file in repo |
| [`tests/electron-printer.test.ts`](../../tests/electron-printer.test.ts) | Plus 1 printer port: BUSY after a strobe, other status bits undisturbed, captured bytes, state save/load (and a state from before BUSY existed); the Save-menu service; with the real Plus 1 ROM, `*FX5,1 : VDU 2 : PRINT "HELLO"` is captured with every byte preceded by a status poll, and a printer held BUSY holds the text back (skipped when the cached ROMs are absent) | Test file in repo |
| [`tests/tape/uef.test.ts`](../../tests/tape/uef.test.ts) | UEF codec against the specification 0.10: framing, 300 baud, carrier, gaps, `&0111` dummy byte (decoded as `&AA` through the receiver), `&0113` base frequency, `&0104` negative stop count, `&0114` security cycles (slow/fast cycles from the most significant bit, `P` flags as lone pulses, count clamping), `&0115`/`&0120`/`&0130`/`&0131` leaving the tape unchanged | Test file in repo |
| [`tests/electron-ocr.test.ts`](../../tests/electron-ocr.test.ts) | OS font lookup, mode 6 and mode 1 text reading, inverse video, screen wrap | Test file in repo |
| [`tests/electron-boot.test.ts`](../../tests/electron-boot.test.ts) | With the real ROMs in `mcp/.cache` (skipped when absent): boot to the BASIC prompt, BASIC from the keyboard, BASIC panes, tape SAVE then LOAD round trip; Plus 1/Plus 3 start-up banner and `*HELP`; ADFS L catalogue and a file load across a track boundary (needs `ZX84_ADL`); DFS catalogue and SAVE/LOAD round trip from the saved `.ssd` | Test file in repo |
| [`tests/disc-formats-boot.test.ts`](../../tests/disc-formats-boot.test.ts) | With the real ROMs: the ADFS L disc as MFM `.hfe` and `.scp` loads a file across tracks as the `.adl` does; an FM `.hfe` boots under the 1770 DFS and a program saved to it comes back from the saved `.hfe`; a DFS disc is refused in ADFS mode | Test file in repo |
| Electron `.uef` collection (752 files), headless | Almost all load and run; three file-level-chunk UEFs parse to no blocks | 2026-10-18 |
| ADFS `.adl` discs (5 BeebEm images) | Read, and SAVE then reload round trip, verified | 2026-10-18 |
| Acornsoft cartridge pairs (`_1`/`_2`) | Work as one concatenated 32 KB image | 2026-10-18 |
| Electron DFS `.ssd` collection (117 discs) booted with SHIFT+BREAK on the ACP DFS | 89 boot without a disc error after 3000 frames, 28 show one (the Known issue above; re-run unchanged by this work, with the cause traced for most of them) | 2026-10-31 |
| 46 high-quality BBC `.uef` tapes using `&0114` security cycles (from the BBC collection; the Electron collection has none), played through the deck and the shared receiver | Every `*`-synced cassette block comes back in order on 44 tapes, with and without the security cycles played; SuperPool recovers 63 of 66 with them and 64 without (it repeats near-identical blocks, so the count is approximate); Stairway to Hell recovers 116 of 219 either way. The junk the cycles make before a block is not decoded as the block | 2026-10-31 |
