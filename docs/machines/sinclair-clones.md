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
| Pentagon 128 / 512 / 1024 | The Sinclair 128K pair (`128-0/1.rom`) | hosted; a Pentagon-branded ROM can replace it |
| Scorpion ZS-256 | 0 Scorpion 128K menu, 1 48K BASIC, 2 service ROM, 3 TR-DOS 5.03 | hosted: `clones/scorpion-zs256-v25c.rom` (ZS-256 "Yellow" v2.5c) |

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
| EFF7 control port | 1024 | ◐ | Bit 2 (128K / 1 MB) and bit 3 (writable RAM bank 0 over 0x0000, ROM hidden) emulated; the turbo and video bits are latched only |
| 1FFD paging | Scorpion | ✅ | D0 maps writable RAM bank 0 over 0x0000; D1 selects the service ROM (page 2) whatever 7FFD D4 says; D4 is RAM page bit 3 |
| AY-3-8912 | all | ✅ | Clocked at 1.75 MHz (CPU clock ÷ 2), not the Sinclair 128K's 1.7734 MHz |
| Beta Disk / TR-DOS | all | ✅ | WD1793, drives A:/B:. Always fitted, so the Hardware-pane toggle is hidden. The Scorpion takes TR-DOS from ROM page 3 and also exposes the FDC ports while its service ROM is selected |

---

## Peripherals

The shared Spectrum peripherals apply (Kempston and Sinclair/Cursor joysticks,
Kempston and AMX mice, Multiface). The +D and Interface 1 are not offered:
they overlay the same slot as the built-in Beta Disk.

---

## Media formats

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.trd` / `.scl` | Disk | Beta Disk | ✅ | ✅ | The native format of this scene |
| `.hfe` / `.scp` | Disk | Beta Disk | ✅ | ✅ / ✗ | |
| `.szx` | Snapshot | Machine | ✅ | ✅ | The only save format for the 512, 1024 and Scorpion (every bank is kept; EFF7 and 1FFD ride in the byte shared with 1FFD) |
| `.z80` | Snapshot | Machine | ✅ | ◐ | Pentagon 128 only (hardware mode 9); `.z80` cannot hold more than 128K |
| `.tap` / `.tzx` / `.csw` | Tape | Tape deck | ✅ | ✗ | |

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Timing | ◐ | Frame lengths as above. The Pentagon first-pixel offset (17,988) and the Scorpion's (14,344) are figures taken from references and are not hardware-verified |
| Fast ROM loading | ✅ | Active when the 48K BASIC ROM is paged in (ROM page 1 on the Scorpion) |
| Software library | ◐ | The catalog carries ZXDB's Pentagon and Scorpion titles, with their TR-DOS images (`.trd`/`.scl`) as a Beta Disk format. On a clone the Machine filter gains a Pentagon or Scorpion option (it matches the titles ZXDB tags for that machine and every TR-DOS image). Tapes auto-load through the menu. A TR-DOS disk is mounted, the machine reset and the disk booted: on a Pentagon the menu's "48 BASIC" is picked and `RANDOMIZE USR 15616` then `RUN` typed; on the Scorpion the default "128 TR-DOS" entry is taken and `RUN` typed. A disk with no `boot` file stops at TR-DOS's "NO FILE" |

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
| The Scorpion TURBO+ v2.92 / v2.95 ROMs hang on the menu's "128 TR-DOS" entry | Scorpion with those ROMs | medium | The service-ROM BIOS polls the FDC status for bits 7–5 after a Read Address; the cause is not understood. The v2.5c ROM that zx84 hosts works |
| The Pentagon 128 ROM is the Sinclair 128K pair, not a Pentagon ROM | Pentagons | low | The banner and menu say Sinclair; software compatibility is unaffected. A Pentagon-branded 128 ROM (with its TR-DOS menu entry) dropped on the ROM pane works, including the library auto-boot, which finds its menu wait by byte pattern; zx84 does not host one |

## Not emulated

- **The Scorpion's "even M1" rule.** On the real board an opcode fetch from RAM that would start on an odd T-state takes one extra wait. Tight RAM loops run slightly faster here.
- **Scorpion turbo (7 MHz), the #FF attribute floating bus and the NMI service monitor.**
- **Pentagon 1024 turbo and the extra video modes** (EFF7 bits other than 2 and 3).
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
