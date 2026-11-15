# Commodore 128: research answers to the open questions

Written 2026-11-15 on `feature/c128`. This answers the list of "things I am unsure about" that was drawn up
after the cartridge, 2 MHz, Z80 debug and banked-cartridge work, using the VICE test programs as the source of
truth wherever they have one.

## Status: what has been fixed from this (2026-11-15, uncommitted on the same branch)

Section 4's items are done as follows. Nothing here was checked in a browser.

- **1 Z80 timing:** T-states / 2 with the odd one carried; no NMI to the Z80. `tests/c128/c128-z80-timing.test.ts`.
- **2 `$D030`/`$D02F` in C64 mode:** live; the MMU registers are hidden at `$D5xx` there.
- **4 page 0/1:** VICE's algorithm ported into `Mmu.relocate` (the Z80 variant has no port exemption). All 18
  `c64modemmu` and all 22 `mmuswap` PRGs run green on the real code (they were run, not just ported);
  `tests/c128/mmu-pages.test.ts` holds the cases. Page 0/1 are block 0's until a pointer moves them.
- **`tstz80bk` (the open decision):** the Z80's `IN`/`OUT` reach `$Dxxx` whatever CR bit 0 says. That is the reading
  under which the test, which runs on real machines, passes (it restores the pointers with I/O switched out).
- **6 CIA timer B mode 3:** counts timer A underflows like mode 2.
- **7 cartridges:** short images mirror; Warpspeed and Partner copy to `$C000`; Magic Desk 128 decodes all of
  `$DE00-$DEFF`, masks to the next power of two of its banks and takes CRT chips in file order (its read-latch is
  not modelled); Partner's register is any write to `$DE80-$DEFF` and its RAM powers up `$FF`; **Comal 80 is built**.
  Gmod2-C128 is still refused.
- **8 VDC:** a "VDC chip" Hardware option (8563 R7A, 8563 R8/R9 default, 8568); R25 scroll direction and zero point;
  double-pixel mode; the R22 display-stop table; R23 + 1; the 16K/64K address maps; R16/R17 read-only; unused bits
  read as 1; a copy leaves its last byte for a fill. With the real ROMs the editor now writes R25 = `$47`.
- **9 2 MHz (decision: as the hardware does):** the VIC-IIe is no longer blanked. It runs on, never holds the CPU,
  and its c- and g-accesses read the CPU's data bus; the refresh cycles and I/O accesses are laid out on a half-cycle
  clock (`fast-clock.ts`). The 2mhzVIC hires picture comes out **pixel for pixel** against the reference screenshot,
  multicolour and extended colour match apart from the palette, and timing-change0 matches. The refresh offset (line
  cycle 9) and the c-access half (26) were *calibrated* on those pictures, not measured, and are tied to how this
  machine times its interrupt entry. Sprites still read memory.
- **11 host keys:** the arrows, Tab and the keypad (KP ENTER too) press their own cells in 128 mode; Page Down is
  LINE FEED.
- **13 Z80 interrupt log:** wired. **Not done:** the internal function ROM media slot, `burstcheck` and two-drive tests.
- **Not started:** 10's Magic Desk read latch, 14 (Gmod2-C128, Partner freeze logic, REU, interlace, VDC busy timing),
  15 (CP/M: `cpm3.d81` still stalls in the boot, cause unknown).

## 1. Method and how far to trust it

Sources, in order of weight:

- **VICE-testprogs** (the `libsidplayfp/VICE-testprogs` mirror of VICE's own test-program repository). Its C128
  programs are written against real machines; many carry readmes, photographs of real output, and per-unit result
  tables. This is the nearest thing to ground truth that is not a real machine.
- **VICE's own source** (`VICE-Team/svn-mirror`, `vice/src/c128`, `viciisc`, `vdc`, `c64/cart`, `z80`, `drive`).
  This shows what a mature emulator does, which is not always what the hardware does.
- The forum threads, bug reports, MAME drivers and manuals that the readmes link to.
- The real C128 ROMs already in the repo (disassembled where a question turned on what the KERNAL does).

Evidence levels used throughout:

| Tag | Meaning |
|---|---|
| **H** | Verified on real hardware: a test readme, a photograph of real output, a measurement, or a designer's own document. |
| **V** | How VICE implements it. Not necessarily hardware-verified. |
| **W** | How MAME implements it (built from schematics). A second, independent implementation. |
| **R** | Read from the real ROM bytes. |
| **M** | Inference by the researcher. |

How this was produced: six research passes ran in parallel, one per group of questions. Each wrote a detailed
report with file and line citations. I read all six and wrote this file from them. **I have not re-run their
scripts or re-checked every cited line**, so treat the line numbers as pointers, and the headline conclusions
as strong but not independently confirmed. Where a result rests on a researcher's own experiment it is said so.
Nothing in the emulator was changed.

The detailed reports, with the full evidence and discrepancy tables, are kept in the session scratchpad:
`c:\temp\claude\555b136385b1e674\29c51561-d2fd-4a22-9ea3-96499cfadc9a\scratchpad\research\` (`01-2mhz.md`,
`02-z80.md`, `03-vdc.md`, `04-cartridges.md`, `05-mmu-variants.md`, `06-input-cia-drives-reu.md`, plus
`02-z80-timing-table.csv`, the real per-instruction Z80 timings). Copy them into the repo if you want them kept.

## 2. What the research changed

### 2.1 Things we had wrong

| # | What the emulator does now | What is actually true | Level | Size of fix |
|---|---|---|---|---|
| 1 | In 2 MHz mode the VIC-IIe is **blanked**: border colour everywhere, no bad lines, no sprite DMA. | The VIC keeps running. Its raster, border and bad-line and sprite-DMA sequencing continue; only its data fetches read the CPU's data bus instead of RAM. BASIC `FAST` blanks the screen in **software** by clearing DEN. | H | Medium |
| 2 | The 2 MHz bit (`$D030` bit 0) and `$D02F` do nothing in C64 mode. | They work in C64 mode. The real-hardware test programs set `$D505=$F7` (C64 mode) and still show the effect; cc65 writes `$D030` from C64-mode code. | H | Small |
| 3 | A fast line is 126 CPU cycles (PAL) / 130 (NTSC). | 121 / 125. Five DRAM-refresh cycles per line always run at 1 MHz. | H | Small to medium |
| 4 | The Z80 rounds each instruction **up** to a whole 1 MHz cycle. | The real rule is exactly T-states / 2, with the odd half carried forward. 715 of the 1,868 real timing tests differ on ours; LDIR is 11.0 cycles/byte against the real 10.5. | H | 5 lines |
| 5 | C64 mode ignores page 0/1 relocation in both directions. | Forward translation is off in C64 mode but **reverse translation stays on** (an access to the target page reads page 0/1). 7 of the 18 `c64modemmu` tests fail on ours. | H | Small to medium |
| 6 | The MMU registers (`$D500-$D50B`) are visible in C64 mode. | They are hidden there. A C64 program writing a second SID at `$D500` would flip our RAM bank, or even leave C64 mode. | V + secondary sources | Small |
| 7 | Pages 0 and 1 follow CR bit 6 when nothing is relocated, and shared-RAM mode has no reverse translation. | Pages 0/1 always go through the P0/P1 pointers (default: bank 0). 6 of the 22 `mmuswap` tests fail on ours (00, 01, 06, 07, 08, 16). | H (11 real units) | Small to medium |
| 8 | The Z80 receives NMI (RESTORE, CIA 2). | It does not. VICE ignores NMI for the Z80 and two independent hints say the pin is not connected. | V + M | Delete a branch |
| 9 | The Z80's reads and writes of `$0000`/`$0001` share the 8502's "never relocate the CPU port" rule. | The Z80 has no CPU port at `$0000/$0001`, so those addresses relocate for it. The `tstz80bk` test fails on ours because of this. | H (test) + V | Small |
| 10 | A short function-ROM image is not mirrored; the `$C000` half stays `$FF`. | VICE mirrors an 8K chip over its 16K half and shows a 16K ROM at both `$8000` and `$C000`. The ROM's vectors at `$FFFA` come from the cartridge under the KERNAL-out configuration. | V + R | Small |
| 11 | VDC smooth scroll (R25) shifts the picture **left** by R25 and the VDC reports version 0. | Increasing R25 moves the picture **right**, and the unscrolled value is `R22 >> 4`. The KERNAL editor writes `$47` unless the version is 0. It works today only because the version is 0. | V + D + R | Small |
| 12 | CIA timer B mode 3 counts nothing. | It should count timer A underflows (with CNT idle high), like mode 2. | V, data sheet | One line |
| 13 | Host arrow keys in C128 mode press the C64-style cursor key plus SHIFT. | The dedicated arrow keys on the extra K2 line are the real ones in C128 mode. | V | Small |

### 2.2 Things confirmed correct

- **Z80 instruction timings in the shared core**: all 1,868 real tests match T/2 exactly. No change to the core is needed.
- **OUTI/OUTD/OTIR/OTDR** put the already-decremented B on the high address byte, as the real-hardware test and the Zilog document require; `tstouti` and `tstouti2` pass on our machine.
- **I/O stretching**: a real `inc $d020` costs 8 cycles in fast mode, which our rule reproduces for that alignment.
- **`$D030` read-back** is `value | $FC`, as ours.
- **KERNAL function-ROM autostart** (see 3.3 below) and our "both lines stay high" model for 128 cartridges.
- **Ultimax and the other 64-cartridge modes in C64 mode** match VICE's tables, which are the C64's.
- **Banks 2 and 3 alias banks 0 and 1** on a stock 128, so ignoring CR bit 7 and RCR bit 7 is right.
- **Extra keyboard matrix** (K0-K2 via `$D02F`), CAPS LOCK on 8502 port bit 6, 40/80 on `$D505` bit 7: all match the real ROM's decode table.
- **Burst direction pins and the bit-level fast-serial wiring**: match VICE and MAME.
- **NTSC support already exists** (65 cycles by 263 lines at 1.022727 MHz).
- **Tests we already pass**: `mmuregister-should-not-mirror`, the P0H/P1H tests, `mmuversion`, `vic-mmu` (both), `openio`, `ram0001mmu` test 2.
- **The KERNAL 318020-05 we host is the final revision** (the -03 and -04 KERNALs have known bugs).

## 3. Answers to each question

The numbering follows the original list of unknowns.

### Q1. The 2 MHz timing rules

**Which accesses slow to 1 MHz (H).** Every access in `$D000-$DFFF` while I/O is visible: the VIC and its mirrors,
SID, the MMU, the VDC, colour RAM, both CIAs, and the cartridge I/O pages. `inc $d020` measures 8 cycles against
6 for `inc $c000` (`c128/2mhzVIC/timing-change0.asm`). VICE's rule (V) is phase-aware: an access that starts on
the first half of a 1 MHz cycle costs an extra half cycle, one that starts on the second half costs nothing, and
a read-modify-write adds a full cycle on the write. Ours is "one extra half cycle per access", which is right for
that aligned case and slightly slow for loops of single I/O reads. Whether `$FF00-$FF04` is stretched on hardware
is not known (VICE does not stretch it).

**Refresh (H).** Five cycles per line run at 1 MHz whatever the CPU is doing, borders and bad lines included. A fast
PAL line is therefore 2 × 58 + 5 = **121** CPU cycles (NTSC 125). Every test program sums to exactly 121 by hand
(`2mhztest.asm`, `hires-test.asm`, `timing-change0/1.asm`), and the tests' own comments say "refresh DMA cycles run at
1 MHz". The offset of the five refresh slots inside the line is **not** settled: VICE uses line cycles 11-15
(0-based), the 6569 chart suggests one cycle different.

**Blanking (H).** There is none in hardware. The photos in `c128/2mhztest/` show a band of eight lines displaying the
code stream as graphics, with normal text above and below, intact borders and a live background colour. In the
display window the VIC cannot read RAM (the CPU owns both bus halves), so it displays what is on the CPU bus: the
colour nibble comes from the low nibble of the opcode byte, the pixel byte from the operand. It never stalls the
CPU. The `2mhzVIC` programs draw entire hires, multicolour and extended-colour pictures this way. The classic
use of 2 MHz is in the borders and vertical blank, where there is nothing to fetch; that is a software technique
rather than a hardware rule. After clearing `$D030` the bus hand-back lags by about one instruction.

**64 mode (H).** The tests run in C64 mode and work. `$D030` bits 7-2 read as 1 and are ignored on write.

**The test bit (`$D030` bit 1)** makes the VIC skip raster lines (`d030tester` reports "Lines cut"). It is not
modelled and I would leave it out.

**Unresolved:** the refresh slot offset, the VIC's exact sampling phase, sprite behaviour in 2 MHz (the forum says
the DMA is still sequenced with CPU-bus data; no photograph), and `$FF00` stretching.

**What to do:** keep the VIC state machine running in 2 MHz mode, still never stall the CPU, and either draw the
normal picture from RAM (what VICE does, simple) or draw from a CPU-bus latch (what the hardware does, medium
work). Add the refresh term, make the I/O rule phase-aware, drop the C64-mode masks, and change the speed-ratio
test, since a correct model gives 121/63 = 1.92, not 1.95-2.05. `FAST` from BASIC must keep blanking the screen via
DEN; the researcher recalled this from the C128 Programmer's Reference and it should be confirmed by running the
existing real-ROM test.

### Q2. Z80 timing

**The real rule (H): every Z80 instruction takes T-states / 2 cycles of the 1 MHz clock.** There are no wait states and
no stretch on I/O, M1 or the repeat instructions. The real timing suite
(`c128/z80/c128z80timing`, 1,868 tests, by Jussi Ala-Könni and Roberto Muscedere, 2024) matches T/2 for every
instruction. A separate measurement (`cycletimer`) gives LDIR at 10.5063 cycles/byte on a real PAL C128, where
VICE 3.2 showed the "incorrect" 11.0117. The mechanism, from Commodore's own Programmer's Reference Guide
(H, documentary): the Z80 clock is generated by the VIC as "a 4 MHz clock that occurs only during AEC low", which
gives two Z80 clock ticks per 1 MHz cycle, with no `/WAIT` involved.

**Ours.** The core's T-states are right for every one of the 1,868 tests (the researcher decoded the real programs
and ran them through the core). The fault is in the machine: `stepZ80` does `Math.ceil(dT / 2)` per instruction and
never gives the half back. The fix is local to `c128-machine.ts` and carries the odd T-state forward, as VICE does:

```ts
const dT = z80.tStates - before + this.z80Half;
this.z80Half = dT & 1;
this.cpu.tStates += dT >> 1;
```

with `z80Half` reset on `reset()` and on a CPU switch. No other machine is affected.

**Not measured by anything (M):** whether VIC bad-line and sprite DMA stall the Z80. The Commodore document implies
they must, but the 2024 timing suite blanks the screen, so the amount is unknown. VICE does steal them. Ours
applies the holds at instruction granularity. I would leave it and record it as unverified.

### Q3. Cartridge boards (and Q11, the internal function ROM socket)

All of this comes from VICE's source (V), MAME's drivers (W), the board designer's PDF for Gmod2, and the real
KERNAL (R). None of it has been run against a real banked cartridge image.

**Discrepancies between our `function-rom.ts` and VICE:**

1. **Mirroring.** An 8K chip is mirrored to fill its 16K half; a bare 16K file shows at both `$8000` and `$C000`;
   Warpspeed and Partner copy their 16K into the `$C000` half. This matters in practice: the KERNAL scans **both**
   `$8000` and `$C000`, and with the ROM at configuration `$2A` the vectors at `$FFFA` and up come from the
   cartridge, so any module that runs with the KERNAL banked out breaks on ours.
2. **Magic Desk 128.** VICE decodes the register over all of `$DE00-$DEFF` (ours: `$DE00` only). A *read* of the page
   latches the bus value into the bank (the board does not decode R/W). The bank mask is the next power of two of
   the banks loaded, so a 4-bank image mirrors. CRT chips are taken **in file order**, ignoring the bank field
   (ours reads the bank field, so a CRT whose chips are all "bank 0" fails on ours). There is no disable bit, unlike
   the C64 board.
3. **Partner 128.** The register is any write to `$DE80-$DEFF` (ours: `$DE80` only). The real board also has a
   `$D600-$D60F` write snoop (the VDC register pair mirrored into the cartridge RAM), an NMI push-button, and a
   freeze mechanism that forces the vectors at `$FFFA/B/E/F` to `$DE`, so code runs from the ROM mirror at `$DEDE`.
   Without the freeze logic the Partner menu can never be summoned. MAME and VICE **disagree on the polarity** of
   register bit 6 (clear versus set releases the freeze); the actual ROM would settle it. Power-up RAM is `$FF`
   (ours is zero).
4. **`silverrock128`** in VICE's C128 cart list is a C64 cartridge and has nothing to do with the 128.

**Comal 80 (CRT type 3): fully specified, about half a day.** 96K as six 16K banks, **on ROMH only** (`$C000-$FFFF`;
`$8000` is empty). One CRT chip packet per bank, each `$C000` size `$4000`, in order. Register at `$DE00-$DEFF`:
`bank = {0,0,2,4}[(v >> 5) & 3] | ((v >> 4) & 1)`, the stored register is `v & $F0`, and a read returns it. VICE and
MAME agree on this (medium-high confidence). Header: type 1, so the KERNAL runs it early at reset.

**Gmod2-C128 (CRT type 5): specified, about two to three days.** 512K of flash (29F040) as 32 banks of 16K at
`$8000-$BFFF` only (ROMH is undriven). Register at `$DE00-$DEFF`: write bits 4-0 = bank (bit 4 is also EEPROM
data-in), bit 5 = EEPROM clock, bit 6 = EEPROM chip select, bit 7 = flash write enable; a read (only while selected)
returns EEPROM data-out in bit 7. The EEPROM is an M93C86 in 16-bit mode (2 KB), with a documented serial protocol;
the flash has a 12-state command machine. Things **not** to copy from VICE: it sends every function-ROM write to the
flash regardless of bit 7 (the designer's PDF says writes in `$8000-$BFFF` are snooped only when bit 7 is set), and
its CRT loader uses `bank << 13` where `<< 14` is needed, so VICE cannot round-trip its own Gmod2-128 file. Which
parts are hardware-verified: the register map and bank size come from the board's designer; the EEPROM command
set matches the datasheet; the busy time, the open-bus behaviour with CS low, and the flash timing are VICE
approximations.

**Autostart, from the real KERNAL disassembly (R).** At boot the KERNAL requires `$D505` bits 4/5 (the /GAME and
/EXROM levels) both high, else it assumes a 64 cartridge and goes to C64 mode. Then it scans four slots in this
order: external `$8000`, external `$C000`, internal `$8000`, internal `$C000`. In each it looks for `CBM` at
offsets 7-9, reads a type byte at offset 6, and calls the entry at offset 0 as a `JSR`. **Type 1 runs immediately**
in the early scan; **any non-zero type** is called again in the later BOOT call. A 16K image mirrored to both halves
is therefore entered twice per pass, and modules guard for that. VICE never changes /GAME or /EXROM for a 128
cartridge, and ours matches.

**Internal function ROM socket.** `memory.intRom` exists and is read by `mapped()` but nothing sets it, it is not in
snapshots, and it has no media slot. VICE offers none, ROM, RAM or RTC; a minimal version needs a setter, a snapshot
field, a bare 8/16/32K or C128 `.crt` load path (16K mirrored into the high half), and an eject. About half a day
for ROM only, plus half a day for a battery-backed RAM mode. The RTC variant I would skip.

**64 cartridges in C64 mode on the 128** use the C64's PLA tables, Ultimax included, in VICE. The 64 mode's
cartridge I/O pages also answer in C128 mode in VICE; unlikely to matter. No source tests Ultimax on a real C128, so
this is V and M only.

### Q4. VDC (8563/8568)

The five items from the plan doc's "not done" list:

| Item | Real behaviour | Ours | Ever noticed by real software? |
|---|---|---|---|
| **Interlace (R8)** | Only `R8 & 3 == 3` changes the picture. Counts are in frame lines; programs double the vertical totals to keep 50 Hz (`vdcattr`: R4 `$4C`, R6 `$32`). A plain weave: render as non-interlaced but taller (about 704 × 496). The photographed "memory read glitches" are unexplained. | Not drawn; a 50-row picture is clipped at 248 lines. | Low. Interlaced bitmap viewers only. |
| **Display-enable window (R34/R35)** | A column window, which can wrap; outside it the beam blanks to **black, border included** (H: `soci/test11/12.jpg`). VICE essentially ignores it. | Not drawn. | Never by the editor, BASIC 7, CP/M or GEOS 128. Raster-split demos only. |
| **Light pen (R16/R17, status bit 6)** | Raw counters, column offset +22. Reading R16 or R17 clears bit 6. The pen signal is the same control-port line the VIC uses. | R16/R17 plain read/write; bit 6 never set. | Only `vdclptest` and pen paint programs. Make R16/R17 read-only at least. |
| **Block copy/fill timing and the ready bit** | VICE (fitted to a real machine, approximate): busy 43 cycles after R18/R19/R31 access in the active area, 4 in the border; fill 0.66 cycles/byte, copy 1.2. After a copy R31 holds the last byte read. | Always ready; completes at once. | Never for correctness: the KERNAL, BASIC, GEOS and CP/M all poll bit 7 with `BIT`/`BPL`. Only changes how long a screen clear takes. |
| **Scroll directions** | **R24: the picture moves up** (ours matches). **R25: increasing the value moves the picture right**; for the 8563 R8/R9 and the 8568 the unscrolled value is `R22 >> 4`; the 8563 R7A is different. | Shifts **left** by `R25 & 15`, with a zero point of 0. | Latent: invisible only because we report version 0. |

**Things the research found that were not on the list, and that matter more:**

1. **Version bits.** The KERNAL editor reads `$D600 & 7` at `$E17E`; if non-zero it writes R25 = `$47`. We report
   version 0 (the rare 8563 R7A), so it writes `$40`. VICE defaults to version 2; a flat 128 usually has 1 (8563
   R8/R9), the DCR has 2 (8568). Fix the scroll formula **before** changing the version.
2. **Double-pixel mode (R25 bit 4)**, the VDC's "40-column" mode, is not drawn at all. `40columns/notes.txt` and
   its real photograph prove it: the cell pitch is `2 × (R22 >> 4)`.
3. **R23** is probably off by one: VICE shows `R23 + 1` lines, we show `R23`.
4. **64K address mapping (R28 bit 4)** is not implemented. Two real maps exist (a 64K chip in 16K mode, and a 16K
   chip in 64K mode), documented in `vdcdump/patterns.txt` from four real machines. Only RAM-size detectors notice.
5. **Status bit 5** is "outside the displayed rows" (top and bottom border), per the `VBlankArea.jpg` photograph.
6. The R22 low nibble (display stop), the flash-attribute blink rate (16/30 vs 16/32 frames), and whether the cursor
   end line is inclusive are small and unverified.

**vdc4, vdccrash, 40columns.** `vdc4` is unexplained: a real 128 does not show the character that VICE shows; do not
model it or use it as a test. `vdccrash` (R1=80 in double-pixel mode crashed VICE) only requires that our renderer
stays bounded, which it does through per-pixel clipping; keep that when adding double-pixel mode.

**Order of work:** the scroll formula, then the version option (default 1), then double-pixel mode, then the 16K/64K
maps, then R23 and the R22 table, then the small R16/R17 and copy-register fixes. Skip R34/R35, the light pen and
per-line effects: they need a per-line renderer and nothing you named uses them.

### Q5. CIA timer mode 3 and SRQ

- **Mode 3** is timer B counting timer A underflows only while CNT is high. VICE treats it as mode 2, which is correct
  whenever CNT idles high, as it does on the 128. No test in `tp/CIA` exercises it and no C128 software was found
  that needs it (not exhaustive: GEOS and CP/M were not disassembled). Ours counts nothing in mode 3, so the fix is
  one line in `mos6526.ts` (`advanceTo`): treat 3 like 2. A real CNT-level gate is not worth building.
- **SRQ on the 128** feeds CIA 1's **CNT** (the fast-serial clock) with DATA on SP. It is on /FLAG only on the C64,
  per MAME. Nothing on the 128 needs SRQ to /FLAG, so leave it.

### Q6. 64-mode page 0/1 relocation

The `c64modemmu` tests are the real-hardware data, and they settle it (H for tests 00-03, 06-14 and 17; 04, 05, 15 and
16 are "to be confirmed" and rest on VICE):

- Forward translation (an access to page 0/1 goes to P0/P1) is **off** in C64 mode.
- **Reverse translation is on**: an access to the target page of P0/P1 is redirected to page 0/1, only in the
  target's own bank, only where the 64 map shows RAM (ROM and I/O win). If P0 and P1 name the same page, P1 (the
  stack) wins; P0=1/P1=0 swaps pages 0 and 1.
- The condition is MCR bit 6. CR bit 6 (RAM bank) and the common RAM carry over into C64 mode, as does the VIC
  bank. **GO64 does not touch the pointers** (the real routine at `$E24B` writes only `$00`, `$01`, `$D030` and the
  stub), so "ignore relocation in 64 mode" is safe for normal software. It diverges only for a program that
  relocates pages and then jumps to 64 mode, which is exactly what the tests do.
- The MMU registers are **hidden** in C64 mode (V: `$D5xx` is open bus), so after bit 6 is set there is no way back
  except reset.

Ours passes 11 of the 18 tests; the seven failures (03, 04, 06, 07, 10, 12, 13) are precisely the missing reverse
translation. The researcher ported VICE's page 0/1 algorithm to TypeScript as a throwaway patch, and with it **all 18
`c64modemmu` tests and all 22 `mmuswap` tests pass**. The algorithm is summarised at the end of
`05-mmu-variants.md` and is a drop-in fix. Real units differ on four `mmuswap` tests (04, 06, 20, 21); VICE and ours
follow the majority.

### Q7. Browser verification

Not answerable from sources; this is still open. None of the C128 UI or the new features has been seen running in a
browser, including the 80-column overlay crop fix.

### Q8. `GRAPHIC`/`COLOR` and 80-column programs

No test program covers them. The one useful finding is that `c128-cpm/cpm3.d81` also contains `zexdoc.com` and
`zexall.com`, so once CP/M boots it doubles as an end-to-end Z80 test. Test programs for BASIC 7 graphics need to
come from the user's own disk images.

### Q9. Drives

- **`burstmode/burstcheck`** tests only the handshake: after LISTEN it reads `$0A1C`, non-zero with a 1571 and
  zero with a 1541. Cheap to add as a test using the shipped `.prg` and disk images.
- Our bit-level burst wiring (SP on DATA, CNT on SRQ, direction from `$D505` bit 3, drive pins on the 1571's VIA 1
  port A bit 1 and the 1581's CIA port B bit 5) matches VICE and MAME. The 128 uses a 10 µs bit, the 1571 7 µs.
- **Gaps:** no test with two or more drives, none mixing a 1571 and a 1581 (the bus fan-out is the thing to check),
  no 1571 **MFM** mode (our 1571 has a WD1770 but "no MFM disk can be put in it"), no G71, no CMD drives.
- GEOS 128 uploads code into the drive and uses fast serial, so the drive-level 6502 model we already have is the
  right design; do not copy VICE's byte-at-a-time shortcut.
- The CP/M route via a D81 avoids the MFM gap.

### Q10. Keyboard

- **Matrix:** 8 columns on CIA 1 port A plus three extra lines K0-K2, selected through `$D02F` bits 0-2, all read on
  CIA 1 port B. The three extra lines carry HELP, TAB, ESC, ALT, LINE FEED, NO SCROLL, the cursor keys and the
  keypad; ours matches the real ROM's decode table (R).
- **Locking keys:** CAPS LOCK (8502 port bit 6), 40/80 DISPLAY (`$D505` bit 7) and SHIFT LOCK (holds the left-shift
  cell). Everything else, including NO SCROLL, is momentary. RESTORE is NMI.
- **C64 mode:** the 64 KERNAL never scans the extra lines, but `$D02F` and `$D030` are VIC-IIe registers the MMU does
  not gate, so they stay live (see Q1). Our docs' claim "as the real chip does" is wrong.
- **Our discrepancies:** the extra-lines mask in C64 mode; host arrows in C128 mode press the 64-style cursor key plus
  SHIFT instead of the K2 cells; the host keypad and `NumpadEnter` type main-row characters instead of pressing
  K0-K2 cells; no host keys for TAB or LINE FEED. VICE's positional keymap has KP+ and KP- swapped against the ROM;
  ours is right. The power-up value of the extra-lines mask differs from VICE (ours 7, VICE 0); the KERNAL always
  writes it first, so it does not matter.
- **Regional layouts:** each national KERNAL carries its own decode tables, so a regional machine needs only the ROM
  plus a host-key map per layout.

### Q11. Internal function ROM

See Q3.

### Q12. CP/M (Phase 8)

CP/M 3.0 on the 128 is mostly software that comes from the disk. The Z80 BIOS in the ROM already contains the CP/M
Plus boot loader (it reads the directory and loads `CPM+.SYS` itself). The emulator's job is the Z80/8502
co-operation, a path that returns 512-byte MFM sectors, the VDC output, and the Z80 fixes above.

**An observed fact worth a closer look:** with `cpm3.d81` in a 1581 on our machine, the KERNAL prints "BOOTING ..." and
then loops, with no READY after 900 frames, and control never returns to the Z80. VICE boots it with the same ROM.
The cause is **unknown**; candidates are the 1581 burst or sector read path, or a missing return-to-Z80 step. A
blank D81 reaches READY by about frame 200, so ordinary boot is fine. This is the main risk for CP/M.

**Work breakdown (researcher's estimates):** Z80 correctness (the half-cycle carry, Z80 page-0/1 relocation, drop NMI,
interrupt log) is small; **find and fix the boot stall** is the big unknown; 1581 sector reads and writes small to
medium; VDC completeness for CP/M's 80-column driver (character set upload, attributes, cursor modes) medium;
a way to boot it and a library entry small. Real 1571 MFM disks are a separate project; **VICE does not support them
either, so plan 1581 only** for a first release.

### Q13. Out-of-scope list (REU and friends)

- **REU:** nothing exists on either the 64 or the 128. A shared device in `src/machines/shared/cbm/` (a
  `DmaHost` interface supplied by each machine) is the right shape, built after release. The four
  `REU/c128` test programs probe which RAM block the DMA hits at 1 MHz and 2 MHz and with VIC bank 1 but ship **no
  pass criteria**. VICE's rule (DMA uses the VIC-bank bits of `$D506`, bypasses the CPU port and page relocation)
  is unconfirmed on hardware. Ask a real-machine owner for dumps before encoding it as fact.
- RAM expanders 1750/1764, printers and RS-232 modems: no findings, still out of scope.

### Q14. Hardware variants and regions

- VICE defines six models: PAL and NTSC for the flat C128, C128D (plastic) and C128DCR. The DCR has the 8568 VDC,
  64K of VDC RAM, 6526A CIAs, an 8580 SID, a combined KERNAL+64 ROM (318023-02) and a 1571CR drive. VICE itself
  notes that ROM differences are not handled.
- **ROMs:** first (318020-03), middle (318020-04), final 318020-05 (ours). Stay on -05.
- **International KERNALs** exist for German, Swedish, Finnish, French, Italian, Norwegian and Swiss machines, each
  with its own character ROM. They are ROM-only differences plus a host-key map per layout.
- **NTSC is already supported.** NTSC is 263 lines for the 8564, not 262 (262 is the old 6567R56A, which the 128
  never used).
- **CR bit 7 / RCR bit 7 and 256K:** nothing to change for the stock machine (see section 2.2). A "256K mod" option
  would need `ram` at 256K, two-bit bank fields and `$D50B` = `$40` (unconfirmed).

### Q15. Z80 interrupts

- The Z80 **does** receive IRQ (VIC raster, CIA 1); VICE routes it through the same status as the 8502. Ours already
  works, IM 1 and IM 2.
- The Z80 receives **no NMI** (V, plus two independent hints). Ours delivers one; delete that branch.
- **Interrupt log:** wire `z80.onInterrupt` and make `interruptedPc()` read the Z80's return address when the Z80 runs.
  About five lines; visible only while CP/M runs, so low priority but cheap.
- VICE itself marks Z80 interrupt timing as a FIXME ("only IM 1 is really supported"), so there is no hardware
  ground truth beyond IM 1 working.

### Q16. Push and PR

Not a research question. Nothing is pushed. Your memory notes say `dev` is the integration branch, so decide the base
when you want a PR.

### Q17. Release items

- **ROM provenance is settled:** 318020-05 is the final KERNAL; the six ROMs were already md5-verified on R2.
- The `ChangelogPane` entry and version bump are still the release step.
- **`docs/machines/commodore-128.md` is stale:** it still says 2 MHz and cartridges are not emulated, and it says the
  C64-mode masks are "as the real chip does". Fix it together with the 2 MHz changes.

### Q18. Order of work

See section 4.

## 4. Suggested work list

Sizes are the researchers' estimates. Everything marked **H** has real-hardware evidence behind it.

**Do first: small, certain, evidence-backed**

1. Z80 half-cycle carry (5 lines, `c128-machine.ts` only; H). Add hardware-derived tests from the timing table.
2. Remove the C64-mode masks on `$D030` and `$D02F`; flip the test and the docs (H).
3. Hide the MMU at `$D500-$D5FF` in C64 mode (V).
4. Port VICE's page 0/1 algorithm, including the reverse arms in C64 mode and shared mode, and the Z80 variant with no
   `< 2` guard (H). Add the 18 `c64modemmu` and 22 `mmuswap` cases as headless tests.
5. Drop the Z80 NMI branch (V).
6. CIA timer B mode 3 counts like mode 2 (V, data sheet).
7. Cartridge mirroring: short images, 16K at both halves, Warpspeed and Partner copied to `$C000` (V + R).
8. VDC scroll formula and a configurable version, default 1 (V + D + R).

**Next: medium**

9. 2 MHz rework: keep the VIC running, refresh term, phase-aware I/O, optional CPU-bus latch rendering (H).
10. Magic Desk 128 whole-page decode, read latch, bank mask, file-order CRT. Comal 80 (0.5 day).
11. Host keyboard: arrows to the K2 cells in C128 mode, keypad cells, TAB and LINE FEED host keys.
12. VDC double-pixel mode, the 16K/64K maps, R23, R22 table.
13. Z80 interrupt log; internal function ROM socket (0.5 day); `burstcheck` and two-drive tests.

**Later: larger or uncertain**

14. Gmod2-C128 (2-3 days). Partner 128 freeze logic. Shared REU. Interlace. VDC busy timing.
15. CP/M: first find the boot stall.

**Leave out:** the VDC display-enable window, the light pen and per-line VDC effects; the 2 MHz test bit; real
Z80 DMA stalls until something proves raster-exact.

## 5. Still open

**Needs a decision from you**

- **2 MHz fidelity:** draw the normal picture without stalling (VICE's behaviour, simple) or model the CPU-bus
  fetches (the hardware's behaviour, medium work)? The alignment-sensitive demos (`2mhzVIC`, `2mhztest`,
  `d030tester`) need the latter.
- **`tstz80bk` (Z80 `OUT` to `$D5xx` with I/O off):** either the OUT works regardless of CR bit 0, or the Z80 gets no
  target-page swap. The test cannot tell which; VICE does the second by omission. The lowest-risk choice is VICE's.
- **VDC default version:** 1 (flat 128) or 2 (DCR)? A "VDC chip" hardware option would cover both.
- **Partner 128 freeze logic and Gmod2-C128:** worth building without a real image to test against?
- **Scope:** CP/M, REU, national layouts, the DCR model.

**Needs real hardware, or a real image**

- A real Magic Desk 128, Partner 128, Warpspeed128 or Comal 80 `.crt`, and the real Partner firmware (to settle the
  bit-6 polarity).
- Real-machine results for the REU variants, `ram0001`, and the four `mmuswap` tests where units differ.
- Anyone able to measure the refresh slot offset, the VIC's sampling phase, sprites in 2 MHz, and the Z80 stall on
  bad lines.

**Unexplained by the sources**

- Why `cpm3.d81` stalls in our KERNAL boot.
- `vdc4` (a real 128 does not show the character VICE shows) and the VDC interlace read glitches.
- Whether `$FF00-$FF04` is stretched in fast mode.
- VICE bug 1987: VICE hides the character ROM from the Z80 at `$D000` with I/O off; ours shows it. Probably
  irrelevant.

**Not researchable from sources**

- Browser verification of the UI and the new features (Q7).
- Which BASIC 7 graphics and 80-column programs you care about (Q8).
