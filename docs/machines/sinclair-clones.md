# Sinclair clones

The Russian ZX Spectrum clones that dominated the ex-USSR scene: the Pentagon
family and the Scorpion ZS-256. zx84 emulates them as extra models of the
Spectrum machine, so they share its ULA, keyboard, tape, snapshot and software
tooling, but with their own timing, memory paging and a Beta Disk (TR-DOS) fitted
on the board.

| | |
| --- | --- |
| **Manufacturer** | Home-built and small-batch Russian and Ukrainian makers; the Scorpion by Scorpion Computers, Moscow |
| **Released** | Late 1980s–1990s |
| **CPU** | Zilog Z80A — 3.5 MHz |
| **zx84 kind** | `spectrum` — [`src/machines/spectrum/`](../../src/machines/spectrum/) |
| **Model ids** | `pentagon128` `pentagon512` `pentagon1024` `scorpion256` — the MCP `model` target and `?model=` value |
| **Accuracy** | Per-T-state CPU; scanline display with mid-line (rainbow) rendering |
| **Status** | Working — boots TR-DOS disk software; 44 of 45 sampled Pentagon titles run |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | RAM | ROM | Paging | Notes |
| --- | --- | --- | --- | --- |
| Pentagon 128 (`pentagon128`) | 128 KB | 32 KB (2 pages) | 7FFD | 224 T/line × 320 lines = 71,680 T/frame; no contention |
| Pentagon 512 (`pentagon512`) | 512 KB (32 banks) | 32 KB (2 pages) | 7FFD D0–D2, D6 (bit 3), D7 (bit 4); D5 locks | |
| Pentagon 1024 (`pentagon1024`) | 1 MB (64 banks) | 32 KB (2 pages) | 7FFD plus D5 as bit 5, gated by EFF7 bit 2 | EFF7 clear (the reset state) = 1 MB mode; set = plain 128K |
| Scorpion ZS-256 (`scorpion256`) | 256 KB (16 banks) | 64 KB (4 pages) | 7FFD D0–D2, 1FFD D4 (bit 3) | 224 T/line × 312 lines = 69,888 T/frame; no contention |

### ROM sets

| Model | ROM pages | Source |
| --- | --- | --- |
| Pentagon 128 / 512 / 1024 | The Sinclair 128K pair (`128-0/1.rom`) | hosted. At load zx84 swaps the menu's "Tape Tester" entry for "TR-DOS" (see below); a Pentagon-branded ROM can replace the pair |
| Scorpion ZS-256 | 0 Scorpion 128K menu, 1 48K BASIC, 2 service ROM, 3 TR-DOS 5.03 | hosted: `clones/scorpion-zs256-v25c.rom` (ZS-256 "Yellow" v2.5c) |

**TR-DOS menu entry.** The Pentagon's menu is the Sinclair one with "Tape Tester"
replaced by "TR-DOS". zx84 does the same when it loads the Sinclair pair on a
Pentagon (`src/machines/spectrum/pentagon-menu.ts`): the entry types
`RANDOMIZE USR VAL "15616"` into the edit line and runs it, which pages TR-DOS in.
The routine is zx84's own, modelled on the Sinclair Tape Loader's tail rather than
taken from a Pentagon ROM. It is applied only when page 0 is the stock Sinclair
128K ROM 0, so a ROM supplied by the user is never altered, and the Spectrum 128K
models keep Tape Tester.

Any page can be replaced from the ROM pane. A 64 KB ROM dropped on the ROM pane
keeps the Scorpion model when it is already selected.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| Z80A CPU | all | ✅ | Shared core; 3.5 MHz |
| ULA (display, border, beeper, keyboard) | all | ✅ | Spectrum ULA with **no memory or I/O contention** and no floating bus |
| 7FFD paging | all | ✅ | Pentagon 128: loose decode (A15, A1 low). 1024: A15=0, A14=1, A1=0. Scorpion: A15=0, A14=1, A5=1, A1=0, A0=1 |
| Extended RAM | 512, 1024, Scorpion | ✅ | See Models; the page at 0xC000 is re-derived whenever EFF7 or 1FFD changes |
| EFF7 control port | 1024 | ◐ | Bit 2 (128K / 1 MB), bit 3 (writable RAM bank 0 over 0x0000, ROM hidden) and bit 5 (hardware multicolour, below) emulated; the turbo, hi-res, 16-colour and other video bits are latched only |
| Hardware multicolour | 1024 | ◐ | EFF7 bit 5: every bitmap byte takes its own attribute from 0x6000-0x77FF of the displayed bank (bitmap 0x4000-0x57FF), giving 32 × 192 attribute resolution. Renders per scanline like the standard screen; a CPU write into the attribute area flushes the beam. The attribute layout comes from the Pentagon 1024SL v2.2 / Pentagon-4096 descriptions, not from a measured board |
| Even M1 wait | Scorpion | ✅ | An opcode fetch from RAM (including RAM mapped over 0x0000 by 1FFD D0) that would start on an odd T-state, counted from the frame interrupt, takes one extra wait. ROM fetches are not delayed. Implemented as a wrapper installed on the Scorpion's CPU at construction (`scorpion.ts`); other models keep the core's own `step` |
| Turbo+ 7 MHz | Scorpion | ◐ | IN from the 7FFD address switches to 7 MHz, IN from 1FFD back to 3.5 MHz; reset returns to 3.5 MHz. Video, INT, AY and tape keep their 3.5 MHz timing, so each instruction (and interrupt acknowledge) is charged half its T-states, an odd half-T-state carried over. No even-M1 wait at 7 MHz (not documented). The state is kept in SZX (private `Z84C` block). The 7 MHz audio and AY pitch are not rescaled |
| #FF attribute port | Scorpion | ◐ | Ports xxxxxxxx xx1xx111 read the attribute byte of the cell under the beam (0xFF in the border and retrace). The fetch phase within a cell is not documented, so the value is the cell's attribute for its whole 4 T-states |
| Magic button | Scorpion | ◐ | The Hardware pane's Magic button latches an NMI that is taken at the next opcode fetch from 0x4000 or above. The DOS signal is raised: ROM page 2 (the service monitor) is mapped over 0x0000 with the FDC ports live (page 3, TR-DOS, when 48K BASIC is selected and 1FFD D1 is clear), the return address is pushed and execution continues at 0x0066. DOS drops on the next fetch at 0x4000 or above, as for the TR-DOS trap. Runs the v2.5c monitor (draws its screen). The monitor's own UI was not driven further |
| 1FFD paging | Scorpion | ✅ | D0 maps writable RAM bank 0 over 0x0000; D1 selects the service ROM (page 2) whatever 7FFD D4 says; D4 is RAM page bit 3 |
| AY-3-8912 | all | ✅ | Clocked at 1.75 MHz (CPU clock ÷ 2), not the Sinclair 128K's 1.7734 MHz |
| Beta Disk / TR-DOS | all | ✅ | WD1793, drives A:/B:. Always fitted, so the Hardware-pane toggle is hidden. The Scorpion takes TR-DOS from ROM page 3 and also exposes the FDC ports while its service ROM is selected. The Beta 128 wires the 1793's READY input to its own HLD output, so status bit 7 reads READY once any command has loaded the head, disk or no disk (the chip's `head-load` option), and READ ADDRESS returns the real ID-field CRC |

---

## Peripherals

The shared Spectrum peripherals apply (Kempston and Sinclair/Cursor joysticks,
Kempston and AMX mice, Multiface). The +D and Interface 1 are not offered:
they overlay the same slot as the built-in Beta Disk.

---

## Media formats

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.trd` / `.scl` | Disk | Beta Disk | ✅ | ✅ | The native format of this scene. Opened with Load or by drag-and-drop it also runs (below) |
| `.hfe` / `.scp` | Disk | Beta Disk | ✅ | ✅ / ✗ | |
| `.szx` | Snapshot | Machine | ✅ | ✅ | The only save format for the 512, 1024 and Scorpion (every bank is kept; EFF7 and 1FFD ride in the byte shared with 1FFD) |
| `.z80` | Snapshot | Machine | ✅ | ◐ | Pentagon 128 only (hardware mode 9); `.z80` cannot hold more than 128K |
| `.tap` / `.tzx` / `.csw` | Tape | Tape deck | ✅ | ◐ | `.tzx` only: what the machine SAVEs is recorded and offered from the Save menu, as on the Spectrum |

### Loading a TR-DOS disk

A `.trd` or `.scl` opened with the Load button, dropped on the page (also from
inside a `.zip`) or played from the library is put in drive A and booted: the
machine is reset and TR-DOS is entered as `RANDOMIZE USR 15616` would, then `RUN`
loads the disk's `boot` file. Inserting from a drive's own menu, or into drive B,
only swaps the disk and leaves the machine running.

The 48K ROM is selected by setting the hardware state rather than typing: on a
Pentagon (and the 128K/+2) 7FFD is written and the ROM cold-started, which unlike
the menu's "48 BASIC" leaves paging unlocked so 128K software gets its banks. TR-DOS
is then called at `0x3D00` from the editor's key-wait, and only `RUN` is typed, once
it is back there. The +2A/+3 menu is still driven by keys. The Scorpion's menu
starts TR-DOS itself (its default "128 TR-DOS" entry), then `RUN` is typed.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Timing | ◐ | Frame lengths as above. The Pentagon first-pixel offset (17,988) and the Scorpion's (14,344) are figures taken from references and are not hardware-verified. The Scorpion's even-M1 wait and Turbo+ clock are in the Built-in hardware table |
| Fast ROM loading | ✅ | Active when the 48K BASIC ROM is paged in (ROM page 1 on the Scorpion) |
| Software library | ◐ | The catalog carries ZXDB's Pentagon and Scorpion titles, with their TR-DOS images (`.trd`/`.scl`) as a Beta Disk format. On a clone the Machine filter gains a Pentagon or Scorpion option (it matches the titles ZXDB tags for that machine and every TR-DOS image). Tapes auto-load through the menu. A TR-DOS disk is mounted, the machine reset and the disk booted (see Loading a TR-DOS disk below). A disk with no `boot` file stops at TR-DOS's "NO FILE" |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger / trace / OCR | ✅ | Shared with the Spectrum; the ROM views list every ROM page |
| MCP tools | ✅ | The Spectrum set, including `betadisk`, `disk_trace`, `fdc_log` and `sector_read` |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| The Scorpion TURBO+ v2.92 / v2.95 ROMs hang on the menu's "128 TR-DOS" entry | Scorpion with those ROMs | medium | Not reproduced: the ROMs are not available here. Reading the v2.5c BIOS, TR-DOS polls the status after READ ADDRESS, and three emulator deviations from the WD1793 datasheet fed that poll: READ ADDRESS returned zero for the two CRC bytes, status bit 5 (record type) and bit 3 could carry over from an earlier READ SECTOR (a Type III status has bits 6–5 clear), and bit 7 reported the drive's READY rather than the Beta 128's HLD-driven READY. All three are fixed and covered by tests; whether that clears the hang is unverified |
| The Pentagon 128 ROM is the Sinclair 128K pair, not a Pentagon ROM | Pentagons | low | The banner says Sinclair; software compatibility is unaffected. A Pentagon-branded 128 ROM dropped on the ROM pane works, including the library auto-boot, which finds its menu wait by byte pattern. zx84 does not host one: the commonly circulated image is Amstrad's ROM with a 65-byte patch of unknown authorship and licence |

## Not emulated

- **The Scorpion's even-M1 wait at 7 MHz**, and the Magic button's interplay with the GMX extensions.
- **Pentagon 1024 turbo, hi-res (512 × 192), 16-colour and 384 × 304 modes.** Turbo is EFF7 D4 with inverted sense (0 = on) in the 1024SL v2.2 description, but its reset state and the clock-coefficient table are not documented well enough to emulate; the other video modes are documented for the Pentagon-4096 and differ between sources (the 384 × 304 mode was withdrawn in 1024SL v2.2). EFF7 D7 (hidden RTC/FDC ports) is not decoded.
- **Other clones** (ATM Turbo, Profi, TS-Conf, Leningrad, Kay).

## Faithful quirks

- **Walker and Land of Myths refuse to run on a Pentagon 128.** They check for 256K or more and print "Sorry, this program only works on a Scorpion ZS256 / Pentagon 256/512". They run on the 512, 1024 and Scorpion.
- **TR-DOS sends WRITE TRACK (command 0xFF) after its first command and waits for INTRQ.** The WD1793 ends it with LOST DATA, which is why the core terminates an unserviced write instead of waiting.
- **The Scorpion menu's "48 BASIC" entry locks paging** (48K mode), so 128K demos need the "128 TR-DOS" entry.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| 45 Pentagon-tagged TR-DOS games and demos (`boot` file via TR-DOS) | 44 run for 30 s; 1 not tested by the harness | 2026-10-18 |
| Walker, Land of Myths, Rage, Dune II, AY Megademo 3, Oxygene 7, Mescaline on the Scorpion (v2.5c, via "128 TR-DOS") | Run, AY output present | 2026-10-18 |
| Hand-derived paging, decode and snapshot tests | [`tests/machines/spectrum/`](../../tests/machines/spectrum/) — `pentagon*.test.ts`, `scorpion.test.ts` | 2026-10-18 |
| Hand-derived timing, turbo, #FF, Magic and multicolour tests (T-state counts of LD A,n loops in RAM vs ROM, 7 MHz halving, beam positions); Magic on the real v2.5c ROM enters the monitor | `clone-boards.test.ts` | 2026-10-31 |
| WD1793 READ ADDRESS status and CRC bytes (CCITT residue over the ID field is zero), HLD-driven READY | `tests/cores/wd1793.test.ts` | 2026-10-31 |
