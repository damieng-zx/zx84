# Plan: Commodore 128

Status: **decisions settled; Phases 0-2 and 4-7 done (research, shared parts, C128 mode booting to READY, the VDC 80-column display, C64 mode, the drives with burst mode, and the machine as part of the app: descriptor, services, UI; cartridges are done: 64 boards in 64 mode and function ROMs in 128 mode; 2 MHz mode too).** Worktree `F:/src/zx/zx84-c128`, branch
`feature/c128`, cut from `dev` and fast-forwarded to 12cdae9d (the VIC-20 merge). When the machine lands, this file
becomes `docs/machines/commodore-128.md`, written to
[`TEMPLATE.md`](../machines/TEMPLATE.md). Follow
[`docs/adding-a-machine.md`](../adding-a-machine.md) for the definition of done.

The 128 is three computers in one case: a C128-mode machine (8502, MMU banking,
BASIC 7.0, two displays), a complete C64 (**GO64**), and a Z80 CP/M machine. It
reuses most of the C64 port: the SID, both CIAs, the tape, the cartridge port,
the drives and the joystick and mouse handling. What is new is the MMU, the
VIC-IIe's extras, the 80-column VDC, the Z80 and the fast serial bus.

Hardware statements below come from memory of the C128 Programmer's Reference
Guide and are **to be confirmed against the documentation and the ROM** (the
way the 1541/1571/1581 work was: disassemble, then model). Anything not yet
confirmed is marked *(confirm)*.

---

## 1. The machine

| | PAL (`c128`, locale `uk`) | NTSC (`c128`, locale `us`) |
| --- | --- | --- |
| CPU | 8502 at 1 or 2 MHz (software-selected), plus a Z80A | same |
| Video | VIC-IIe 8566 (40 columns) and VDC 8563 (80 columns) | VIC-IIe 8564, same VDC |
| Raster | 312 × 63 cycles, as the C64 | 263 × 65 cycles |
| RAM | 128K in two 64K blocks, 16K VDC RAM (64K on the DCR) | same |
| Sound | SID 6581 (8580 on later boards) | same |
| I/O | two CIA 6526s (8521), as the C64 | same |
| Memory manager | MMU 8722 | same |
| ROM | 128K: BASIC 7.0 low/high, screen editor, KERNAL, Z80 BIOS, C64 BASIC and KERNAL, character ROM | same |
| Ports | cassette, serial (IEC, with **fast serial**), user, two control ports, expansion (cartridge), RGBI + composite video | same |

Model ids: start with one, `c128`. The 128D/DCR differences (64K VDC RAM, the
internal 1571, a different KERNAL revision) become Hardware-pane options, as the
C64's drive and SID model are. Add `c128dcr` only if ROM revisions force it.

### What the 128 adds over the 64

| Area | The 128 | Where it lives |
| --- | --- | --- |
| MMU 8722 | Config register `$D500` (mirrored at `$FF00`), four preconfiguration registers `$D501-$D504` (writing `$FF01-$FF04` loads one into the config), mode register `$D505`, RAM configuration `$D506`, page 0 / page 1 relocation `$D507-$D50A`, version `$D50B`. Picks ROM/RAM/I/O per 16K region, the RAM block, the common-RAM areas, which CPU runs, and C64 or C128 mode. *(confirm every bit)* | `c128/mmu.ts`, `c128/memory.ts` |
| VIC-IIe | A VIC-II plus `$D02F` (extra keyboard lines K0-K2) and `$D030` (2 MHz). The 2 MHz mode blanks the 40-column display. *(confirm the exact blanking and clock rules)* | shared VIC-II, `c128/vic-iie.ts` for the delta |
| VDC 8563 | 80×25 text and bitmap, 37 registers behind `$D600` (address) / `$D601` (data, status bit 7 = ready), attributes (reverse, underline, flash, alternate set), hardware scroll, block copy and fill, light pen. The character set is copied into VDC RAM by the KERNAL at boot, so the VDC has no ROM of its own. | `c128/vdc.ts` (single-machine silicon stays in the machine folder) |
| Z80 | Active at reset: it runs the Z80 BIOS, which hands over to the 8502 for a normal boot, or boots CP/M. Only one CPU runs at a time (`$D505`). | existing `src/cores/z80`, wired in `c128/` |
| Keyboard | 8×8 matrix plus 3 more lines: ESC, TAB, ALT, CAPS LOCK, LINE FEED, HELP, NO SCROLL, numeric keypad, four cursor keys. The 40/80 DISPLAY key and CAPS LOCK are read through `$D505` / the 8502 port, not the matrix. *(confirm)* | `c128/keyboard.ts` over the shared CBM keyboard |
| Fast serial | The KERNAL talks to a 1571/1581 in **burst mode**: the CIA 1 shift register clocked over the serial bus, direction set by FSDIR in `$D505`. The 1571 already has its half (CIA at `$4000`). | CIA core + shared serial bus |
| BASIC 7.0 | Text at `$1C01` in bank 0, larger token set including `$CE`/`$FE` prefixed tokens, sprite and graphics commands. | `src/basic/` parser extension |

---

## 2. What already exists

| Need | Existing code | Reusable as-is? |
| --- | --- | --- |
| 6502 core | `src/cores/m6502.ts` (NMOS, undocumented opcodes, edge-triggered NMI) | Yes. The 8502 is an NMOS 6502 with the same on-chip port; 2 MHz is a clock matter, not an opcode matter |
| Z80 core | `src/cores/z80/` | Yes, with machine-supplied memory closures as on the Spectrum/CPC/MSX |
| CIA | `src/cores/mos6526.ts` | **Yes, since Phase 1.** It now has a real SP/CNT shift register (transmit clocked by timer A, receive on CNT edges) and CNT-counting timers |
| SID | `src/cores/mos6581.ts` | Yes, including the 8580 option |
| VIC-II | `src/cores/vic-ii.ts` (moved from `machines/c64/` in Phase 1), reading through a `VicBus` and drawing with a palette the machine passes in | **Yes, since Phase 1** for the 40-column display; the VIC-IIe extras are Phase 3 |
| Drives | `shared/cbm/drive/drive-{1541,1571,1581}.ts` with a `CbmSerialBus` | Yes. The 1571 already has the burst-mode CIA and the 2 MHz clock |
| Keyboard | `shared/cbm/keyboard.ts` and `shared/ui/cbm-keyboard/` | Yes, plus the 128's extra keys |
| Tape | `TapeDeck`, `PulseRecorder`, `c64-tap.ts`, `t64.ts` | Yes |
| Cartridge | `c64/cartridge.ts` (.crt boards) | 64 mode yes; 128 mode needs function-ROM handling |
| OCR, screen text | `src/ocr/c64.ts` | 40-column yes; 80-column is a new, simpler engine over VDC RAM |
| BASIC parser | `src/basic/c64-basic-parser.ts` (V2) | Extend for 7.0 |
| ROMs | VICE's C128 folder under `N:/collections/retro/Commodore/64/Emulators/WinVICE-3.1-x64/C128`: `basiclo` 16K, `basichi` 16K, `kernal` 16K, `basic64` 8K, `kernal64` 8K, `chargen` 8K | Staged locally only. Upload to R2 `zx84/roms/c128/` needs your OK, as before |
| Software | `N:/collections/retro/Commodore/128` (TOSEC D64, D81, LNX, PRG, applications, demos) | Test material |

**Dependency (met).** The VIC-20 merge moved the drives, serial bus, keyboard and
tape/drive services into `src/machines/shared/cbm/`, the layer the 128 builds on. The
Drives and Keyboard rows above describe `c64/` as it was; those files now live in
`shared/cbm/` on `dev`.

---

## 3. Decisions for you

1. **Base branch. Decided and done:** `feature/vic20` is merged into `dev` (PR #68),
   `dev` is pulled, and `feature/c128` is fast-forwarded to it (12cdae9d). The
   `shared/cbm` layer the 128 needs (drives, serial bus, keyboard, tape and disk
   services) is already in the tree, so Phase 1 has no extraction to do.
2. **Two displays.** The 128 has a 40-column composite output and an 80-column
   RGBI output, and a real user looks at one monitor. (a) One canvas with a
   Display menu (40 / 80 / Auto, following the 40/80 key and the last active chip).
   (b) Two canvases side by side. **Decided: (a), Auto by default.** It needs the
   frame size to change at run time, which `frameWidth`/`frameHeight` already allow
   in principle (the Spectrum's change with the border setting), but
   `setCanvas()` builds the renderer once for a fixed size. Expect one small
   generic seam so the shell re-creates the renderer when the machine reports a new
   geometry. That is the only planned edit outside `src/machines/c128/`.
3. **Z80 / CP/M scope.** The Z80 boot path is mandatory (the 128 starts on it).
   Booting a CP/M 3.0 disk is separate: the disks are MFM and need the 1571's
   WD1770, which the drive model does not have. (a) Z80 boot only, CP/M deferred.
   (b) Full CP/M. **Decided: (a)**, with CP/M as its own final phase if wanted.
4. **Machine kind.** (a) A new kind `c128` (an island, sharing through `shared/cbm`
   and `cores/`). (b) A second model of the `c64` kind. **Decided: (a)**: the MMU,
   two displays, two CPUs and their services would swamp `C64Machine`, and the
   registry/descriptor split exists for this.
5. **Debugger with two CPUs.** `descriptor.cpuFamily` is a single value, and the
   MCP and UI debug tools are family-blind through `DebugService`. (a) Report
   `m6502` and make the Z80 invisible to the debugger (the BIOS only runs briefly
   at boot). (b) A `DebugService` that routes to whichever CPU is active.
   **Decided: (a) first**, (b) with the CP/M phase. **Done as (b) ahead of CP/M:** `services/debug.ts`
   routes to the 8502's service or the Z80's by which CPU is in charge (`cpuIs8502`), the register panel
   follows `services.debug.cpuFamily` live, and `descriptor.cpuFamily` stays `m6502`.

---

## 4. Phases

Each phase ends with `npx tsc --noEmit`, `npx vitest run` and `npm run depcheck`
green. Nothing is committed until you ask.

### Phase 0: groundwork *(no emulation yet)*
- Settle decision 1. Create `src/machines/c128/` skeleton, `docs/machines/commodore-128.md`
  stub.
- Stage the six ROM files in `mcp/.cache/` (gitignored). Find where the Z80 BIOS lives
  in the images, how the 8K `chargen` splits between the 64's set and the 128's, and
  record the ROM revisions and md5s. *(confirm)*
- Read the 128 KERNAL/editor boot path to pin down the MMU bits the way the
  1541/1571/1581 hardware facts were derived. Notes go in `mcp/.cache/c128-dev/`.

**Phase 0 findings so far** (the six ROMs are staged in `mcp/.cache/c128-dev/`, gitignored):

| File | Size | md5 |
| --- | --- | --- |
| `basiclo` | 16K | b86ce827c9108fbc7b9e02c690e81a23 |
| `basichi` | 16K | 87bb251707d0a2c915d6e0c69fdb0fed |
| `kernal` | 16K | 01f6903033b90cd506cde7802ec743c3 |
| `basic64` | 8K | 57af4ae21d4b705c2991d98ed5c1f7b8 |
| `kernal64` | 8K | 39065497630802346bce17963f13c092 |
| `chargen` | 8K | 46b3cb2140f244c0ed1150c819e7bdc4 |

- **The Z80 BIOS is inside the 16K `kernal` image at offset `$1000-$1FFF`** (the part the
  8502 sees under the `$D000` I/O window). It begins `3E 3E 32 00 FF C3 3B 00 31 77 3C`:
  `LD A,$3E`, `LD ($FF00),A` (a write to the MMU configuration register), `JP $003B`,
  `LD SP,$3C77`. The Z80 sees `kernal[$1000..$1FFF]` as its `$0000-$0FFF` (confirmed:
  the branch targets and `LD SP` line up only at that base).
- The 8502 side begins at `$E000` of the same image (`A2 FF 78 9A D8`: `LDX #$FF`, `SEI`,
  `TXS`, `CLD`), and `$C000` is the screen editor's jump table (`4C 7B C0 ...`).
- `chargen` is two 4K halves that differ in only 97 bytes: one is the 64's set and the
  other the 128's. Which is which is still to be confirmed (the 64's is expected to match
  `c64/chargen-901225-01.rom`).

**Boot sequence, read from the ROM (disassembled with the repo's own disassemblers, script in
`mcp/.cache/c128-dev/dis.ts`):**

1. Reset: Z80 active, MMU registers 0, RAM bank 0. The Z80 BIOS is visible at `$0000-$0FFF`.
2. `CR := $3E` (via `LD ($FF00),A`), then **`OUT` instructions to `$D02F`/`$D030`** (VIC
   `$FF`, `$FC`) and `$D505` (`$B0`, read back and checked against `$30`: the GAME/EXROM lines
   show a cartridge). So **Z80 `IN`/`OUT` use the full 16-bit port address as the I/O
   area `$D000-$DFFF`**, and work only while CR bit 0 = 0.
3. CIA 1 is set up (`$DC0E/F := $08`, `$DC02/03`) and **column 7 of the keyboard is read
   (`$DC00 := $7F`, test bit 5 of `$DC01`): C= held at reset writes `$D505 := $F1`, i.e.
   C64 mode on the 8502.** Otherwise the BIOS carries on.
4. The BIOS writes eleven MMU registers from a ROM table, `$D50A` down to `$D500`:
   `P1H=$00 P1L=$01 P0H=$00 P0L=$00 RCR=$0B MCR=$B0 PCRD=$7E PCRC=$3E PCRB=$7F PCRA=$3F CR=$3F`.
   RCR `$0B` is common RAM at the **top, 16K**. After `CR=$3F` the Z80's I/O is gone but its
   `$0000-$0FFF` BIOS is still visible, so **the Z80's low 4K is the BIOS whenever the RAM
   bank is 0, independent of CR bit 0** (CR bit 0 only gates its I/O).
5. It copies an 8-byte stub to RAM `$1100` and a 31-byte block to `$FFD0` (common RAM), points
   the vectors at `$FFFA/$FFFC/$FFFE/$FFDD` at `$1100`, and jumps to `$FFE0`: `DI`,
   `CR := $3E`, then `OUT ($D505),$B1`. MCR bit 0 set hands control to the 8502.
6. **The 8502 starts as if reset**: it fetches the vector at `$FFFC` (RAM at that moment,
   `$1100`), runs `LDA #0 / STA $FF00 / JMP ($FFFC)`. CR is now 0, so `$FFFC` reads the
   KERNAL's reset vector `$FF3D` (`LDA #0, STA $FF00, JMP $E000`). `$E000` then starts
   `LDX #$FF / SEI / TXS / CLD` and copies a table into `$D500-$D50A`, then initialises the
   machine.

**MMU facts confirmed or corrected** (from the ROM above, and from VICE's `c128mmu.c` and
`z80mem.c` read as a behaviour reference, not copied):

| Item | Fact |
| --- | --- |
| Registers | 12 at `$D500-$D50B`; CR also at `$FF00`; `$FF01-$FF04` write = load PCRA-D into CR |
| CR | bit 0 `$D000` area (0 = I/O, 1 = ROM/RAM); bit 1 `$4000-$7FFF` (0 = BASIC low ROM, 1 = RAM); bits 3:2 `$8000-$BFFF` (00 = BASIC high ROM, 01 = internal function ROM, 10 = external function ROM, 11 = RAM); bits 5:4 `$C000-$FFFF` (00 = KERNAL, 01 internal, 10 external, 11 RAM); bits 7:6 RAM block |
| MCR (`$D505`) write | stored as `(v & $7F) \| $30`; bit 0 selects the CPU (**1 = 8502, 0 = Z80**); bit 3 FSDIR (fast serial output); bit 6 = C64 mode |
| MCR read | low nybble as stored; bits 4 and 5 are the **levels** of the cartridge port's /GAME and /EXROM pins (1 with nothing plugged in: the BIOS does `IN A,(C) / CPL / AND $30` and takes a 0 for a cartridge; an earlier note here said inverted, which sent the first boot into C64 mode), **bit 7 = 40/80 key released (1 = 40 columns)**; bit 6 as stored |
| RCR (`$D506`) | bits 1:0 common-RAM size 1K / 4K / 8K / 16K; bit 2 common bottom; bit 3 common top; bits 7:6 the RAM block the VIC-IIe sees |
| P0/P1 | `$D507` P0L, `$D508` P0H, `$D509` P1L, `$D50A` P1H; **the high byte is latched and only takes effect when the low byte is written**; high-byte reads return the top 4 bits set; reset values P0 = page `$00`, P1 = page `$01` |
| Version | `$D50B` reads `$20` |
| Z80 view | I/O from the `$Dxxx` port address only when CR bit 0 = 0; the 8502-only parts (cartridge detection, C64 mode) behave as above |
| 8502 reset | on taking control it reads `$FFFC` from whatever CR then maps |

The two items that were left *(confirm)* are settled by Phase 2: the top common RAM starts at
64K less its size (`$C000` for the 16K the BIOS sets), and the 8502 port has meanings in 128 mode
(see Phase 2).

### Phase 1: shared parts the 128 needs *(done, committed as 71d5a02b)*
- **VIC-II to `src/cores/vic-ii.ts`.** Done. It reads through `VicBus` (`vicRead(addr14)` and
  `colorRam`, which `C64Memory` already had), takes its timing as `VicTiming` (the C64's
  `C64Timing` satisfies it) and its palette as a constructor argument, and saves state through
  the cores' `StateSink`/`StateSource`. The stream is byte-identical. All C64 tests pass; the only
  test edit is the `new VicII(...)` call in `c64-machine.test.ts`, which now passes timing and
  palette. A boot to READY with the real ROMs draws pixel-identical frames before and after
  (md5 of the frame buffer at frames 150, 200 and 300, dev against this branch).
- **CIA serial port.** Done, in `mos6526.ts`. Transmit: a write to SDR with CRA bit 6 set sends
  the byte MSB first over 16 timer-A underflows (CNT low on odd, high on even; each bit valid
  on the rising edge), SP interrupt on the eighth, a byte written meanwhile goes out after it.
  Receive: `cntEdge(t, sp)` shifts SP in, SP interrupt and SDR after eight. Timers A and B
  can count CNT edges. `onShiftOut(bit, t)` reports each transmitted bit. The legacy snapshot
  stream is unchanged; the new state is in `saveSerial`/`loadSerial`. Tests in
  `tests/c64/mos6526.test.ts` from the data sheet.
- **Fast serial on `CbmSerialBus`.** Done for the 1571: `attachFastSerial(hostCia, hostHz)`
  wires the host CIA's and the drive CIA's shift registers to each other, gated by the two
  direction pins (`fastHostTransmits` for the MMU's FSDIR, `fastTransmitting` read from the
  1571's VIA 1 port A bit 1). Tests in `tests/c64/fast-serial-bus.test.ts`.

Not done in Phase 1, and how Phase 6 settled it (with the real 128 ROMs and DOS running):
- Timer mode 3 is still not modelled: nothing seen needs it.
- SRQ through CIA 1's /FLAG: not needed. `DIRECTORY`, `DLOAD`, `DSAVE`, `COPY` and `HEADER` work
  with the shift register and CNT alone, so the level is not modelled.
- The 1581's burst port: its direction pin is CIA port B bit 5 (the DOS makes it an output and
  sets it to send), which `Drive1581.fastTransmitting` reads. Burst works with the 1581 DOS.
- The 1571's snapshot still does not carry the shift-register state; the C128's own snapshot
  format will, via `saveSerial` (Phase 7).
- The real 1571 DOS's burst commands: the 128's KERNAL issues them and they work (Phase 6).

### Phase 2: C128 mode boots to READY on the 40-column screen *(done, 58cef7fc)*
- `c128/mmu.ts`: the register file ($D500-$D50B, $FF00-$FF04): CR, the four preconfigurations and
  their load-config addresses, MCR, RCR, the latched P0/P1 high bytes, common RAM arithmetic, and
  page 0/1 relocation with the swap of the target page. `c128/memory.ts`: the 8502's map, the Z80's
  map, the 8502 port, banked colour RAM and the VIC-IIe's window. Tests are from the Programmer's
  Reference Guide tables, not from the implementation (`tests/c128/mmu.test.ts`,
  `memory.test.ts`): every region against every ROM-select value, writes under ROM, both RAM
  blocks, common RAM at every size at the top and the bottom, relocated pages, the load-config
  writes, the Z80 view and the VIC-IIe view.
- `c128/c128-machine.ts`: `C128Machine extends BaseMachine` (it does not implement `Machine` yet:
  descriptor, services and registry are Phase 7). Power-on with the Z80 running the BIOS, hand-over
  to the 8502 on the MCR write (it starts as if reset, reading `$FFFC` through the map it then
  has), the 64's line loop with the VIC-II's bus holds, CIA 1 and 2, SID, 8502 at 1 MHz.
- `c128/keyboard.ts`: the 64's 8 x 8 plus the three extra lines, read from the editor ROM's decode
  table. `c128/vdc.ts`: register file, RAM and block copy/fill (the display came in Phase 4).
- `shared/cbm/vic-ii-board.ts` now holds the VIC-II board's timing, geometry and palette, which
  `c64/constants.ts` and `c64/palette.ts` re-export (an island cannot import another island);
  `CbmKeyboard` takes a matrix of any width.
- **Verified with the real ROMs** (`tests/c128/c128-machine.test.ts`, skipped without
  `mcp/.cache/c128-dev/`): boots in C128 mode to `COMMODORE BASIC V7.0 122365 BYTES FREE` and
  `READY.`, `PRINT 6*7` prints 42, `BANK 0` and `BANK 1` PEEK different bytes at the same
  address, `PEEK(54533)` follows the 40/80 key. Without ROMs, a synthetic Z80 BIOS proves the
  hand-over, the copy through RAM with I/O off, and the Z80 at two T-states to a cycle.

Facts found while doing it (the ROM and the first boot settled them):
- **MCR read, bits 4 and 5, are the /GAME and /EXROM pin levels** (1 with no cartridge), not inverted.
- **The 8502 port in 128 mode:** bit 0 chooses the colour RAM bank the CPU sees, bit 1 the bank the
  VIC-IIe sees (1 is bank 0 in both), bit 2 low shows the character ROM to the VIC-IIe at
  `$1000-$1FFF` of every bank, bits 3-5 are the Datasette as on the 64, **bit 6 reads low while
  CAPS LOCK is down** (the editor ROM's scan does `LDA $01 / AND #$40 / EOR #$40`). Pulled up: bits
  0, 1, 2, 4 and 6; bits 3, 5 and 7 read 0 as inputs.
- **Colour RAM is 2K**, two 1K banks, not 1K as on the 64.
- **The character ROM:** the first 4K is the 64's set (identical to `chargen-901225-01.rom`), the
  second 4K is the 128's, which 128 mode uses.
- **Keyboard:** the three extra lines are selected by `$D02F` bits 0-2 (low), scan order K0, K1,
  K2: K0 = HELP 8 5 TAB 2 4 7 1, K1 = ESC + - LINE FEED ENTER 6 9 3, K2 = ALT 0 . up down left
  right NO SCROLL (PB0 to PB7), keypad keys type the digits.
- **The VDC is polled during start-up:** the editor waits for the update address to advance after a
  block fill (`R30`), so a stub with no block operations hangs the boot. The register file now does
  copy and fill at once.
- **Z80 IN/OUT:** the high byte of the port address selects the page; `$00-$0F` is RAM at
  `$Dxxx`, `$D0-$DF` is I/O (here only while CR bit 0 is 0 for every chip, where VICE gates just
  the MMU: the boot works either way). The Z80's `$0000-$0FFF` writes land in the RAM at
  `$D000-$DFFF`, and its `$1000-$13FF` is the colour RAM while I/O is on.

Not done in this phase, and why:
- No drives or serial bus on the C128 yet (CIA 2 reads the serial lines as idle): Phase 6.
- No joystick, tape, cartridge, snapshot, descriptor or UI: Phase 7.
- The page 0/1 relocation rules are C128 mode's; C64 mode's (and the VICE source's *(FIXME,
  to be settled on real hardware)* cases) belong to Phase 5.
- The Z80 timing is a flat two T-states to a cycle, with no wait states or DMA; the VIC-II's bus
  holds are applied to it as to the 8502. Phase 8 refines both if CP/M is wanted. (Debug stops
  no longer ignore the Z80: see the Z80 debug and trace paragraph at the end of Phase 7.)
- The two-block (128K) machine only: `CR` bit 7 and `RCR` bit 7 are ignored.

### Phase 3: VIC-IIe extras and 2 MHz *(done)*
- `$D02F` keyboard-line output and `$D030` bit 0. Model the CPU clock in 2 MHz mode
  and what the VIC-IIe does to the picture while it is on *(confirm: blanking, and
  what the CPU gets on bad lines and in the borders)*.
- Frame timing for fast mode: twice the 8502 cycles per frame, the SID/CIA timers still
  on the 1 MHz base. Cycle-count tests with hand-computed loops at both speeds.
- Check the speed cost; the machine must still hold real time in a desktop browser.

**Done.** `$D030` bit 0 (C128 mode only; the 64's map has no such register) runs the 8502 at 2 MHz
against the unchanged 1 MHz master clock the chips keep time by (`C128Machine.fast2MHz`): an
instruction costs half its cycles, a half cycle left over is carried, and every access to the I/O
page is made at 1 MHz and costs a whole master cycle. The VIC-IIe is shut off while it is on
(`VicII.blank`): the border colour everywhere, no bad lines, no sprite DMA, so it never holds the
bus. Tests: `tests/c128/c128-fast.test.ts` (hand-computed loops at both speeds, the I/O cost, C64
mode, the blanking, snapshots, and BASIC's FAST and SLOW on the real ROMs). The Clock row of the
memory-map pane and the VIC chip dump say which clock is running; there is no status LED for it.
The exact I/O stretching and the PAL line-skipping subtleties of the real chip are modelled by
this rule only (not confirmed against hardware).

### Phase 4: VDC and the 80-column display *(done, 69a01414)*
- `c128/vdc.ts`: register file behind `$D600/$D601`, update/data pointers, text and
  bitmap modes, attributes, flash, cursor, scroll, block copy and fill with their
  timing/ready bit, 16K and 64K RAM. Rendered to its own frame buffer.
- Display selection per decision 2 (Auto follows the 40/80 key and whichever chip was
  last programmed). The one generic renderer-resize seam lands here.
- 80-column OCR engine over VDC RAM (screen, attribute and charset), TEXT overlay.
- Tests with hand-computed expectations: indirect addressing, auto-increment of the
  update address, copy with overlapping source and destination, fill, attribute bits.
- **Milestone:** `GRAPHIC`/`COLOR` and the 80-column screen visible; BASIC editor in
  both columns; the programs in `Games - [D64]` marked `[80 Columns Mode]` draw.

**Done:**
- `c128/vdc-display.ts`: `renderVdc(vdc, out)` draws the registers and RAM into a fixed 704 × 248
  frame, the 640 × 200 picture centred in a border of R26's background colour (a fixed frame, so a
  program that changes R1 or R22 cannot resize the canvas). Text and bitmap modes, the 16-byte
  glyphs from the set at `R28 & $E0 << 8` (alternate set 4K on), monochrome and attribute colours,
  reverse (per cell and R24 bit 6), underline at R29, flash (alternates with reverse, 1/16 or 1/30),
  the cursor (steady, none, 1/16, 1/32, over lines R10..R11), the row increment R27, the ninth pixel
  (semigraphic), cell widths and heights from R22/R9/R23, and both smooth scrolls. The palette is
  pure RGBI (`0xAA` per colour, `+0x55` with intensity); no monitor-specific brown.
- `c128/vdc.ts`: `VDC_R` register names, 64K RAM (`new Vdc(VDC_RAM_64K)`), the status register's
  vertical-blank bit (the machine feeds the beam position with `setBeam` each line from R4/R5/R6/R9),
  a frame counter for the flash and blink.
- Machine: one canvas, `showing80` and `setDisplayMode('auto' | '40' | '80')`. The frame size, the
  pixel buffer and the pixel shape (`VDC_PIXEL_ASPECT_X`, 4:3 over the whole frame) follow the chip
  shown, and the machine calls `display.resize`, `display.setPixelAspectX` and `onScreenChange`
  itself when it changes, as the BBC and MTX machines do: **no new shell seam was needed**.
  `ocrScreenForMcp` reads whichever screen is shown (`vdcScreenText` for 80 columns).
- Tests: `tests/c128/vdc.test.ts` (ports, update address, fill, copy including overlap, status),
  `vdc-display.test.ts` (every item above, hand-computed), and machine tests for the display
  selection, the canvas messages and, with the real ROMs, booting and typing on the 80-column screen.

Facts found while doing it:
- **The editor's VDC set-up** (read back after a real boot): R0 `$7F`, R1 80, R4 `$26`, R6 25, R9 7,
  R10 `$60` (blinking 1/32 cursor, lines 0-7), R20 `$08` (attributes at `$0800`), R22 `$78`
  (8-pixel cells, 8 shown), R23 8, R24 `$20` (flash 1/30), R25 `$40` (attributes on, horizontal
  scroll **0**), R26 `$F0`, R28 `$20` (set at `$2000`), R29 7.
- **Auto follows the 40/80 key only, not "the last chip programmed":** the editor programs the whole
  VDC (and clears its RAM) at start-up in 40-column mode too, so VDC activity cannot tell the chips
  apart. The Display menu's 40 and 80 settings override the key.
- Setting the key down after boot (`setDisplay80(true)`) switches what is shown to the VDC, though
  the editor stays on the screen it chose at reset; a program-driven switch is ESC-X or a reset.

Not done: interlace (R8), the display-enable window (R34/R35), the light pen, a block copy's
timing and the ready bit (it finishes at once and always reads ready), and the horizontal and
vertical scroll directions are from the register descriptions and unchecked against a real chip.
The milestone's `GRAPHIC`/`COLOR` (BASIC 7 draws those on the VIC-IIe) and the `[80 Columns Mode]`
programs (they need drives, Phase 6) have not been tried yet.

**TEXT overlay (done):**
- `c128/vdc-ocr.ts`: the 80-column grid over VDC RAM. Its columns and rows are R1 and R6,
  its stride `R1 + R27`, and each cell is `(R22 >> 4) + 1` pixels across by `(R9 & 31) + 1`
  lines down (of which `R22 & 15` and `R23 & 31` are shown) — the overlay therefore owns
  its cell size rather than assuming 8×8.
- **The font is not a chip ROM.** The KERNAL copies one into VDC RAM at boot, at
  `(R28 & $E0) << 8`: two 4K sets of 256 glyphs of 16 bytes, the upper-case set first and
  the lower-case one 4K further on, selected by the attribute's bit 7. Codes 128-255 are
  the inverses of 0-127, and the shared `cbmRomGlyphs`/`cbmMatchGlyph` matcher already
  derives those, so it serves here unchanged once the 16-byte VDC glyphs are repacked to
  the 8-byte layout it expects.
- `vdc-display.ts` grew `vdcGeometry()`, which the renderer and the overlay both read, so
  the rectangles the overlay blanks are the ones the renderer drew: origin, cell and row
  pitch, the shown part of a cell, and both smooth scrolls.
- `c128-machine.ts`: `ocrScreenStyled()` picks the chip on screen (the VIC-IIe's
  `c64OcrGrid` at 40 columns, `vdcOcrGrid` at 80), `textField` and `blankCells` follow the
  same choice, and `blankCells` marks the display dirty so the paint reaches the canvas.
  The 40-column matcher is given the 128's own 4K set (the second half of the character
  ROM), and the 64's first half in 64 mode.
- `services/frame-probe.ts`: a `C128TranscribeDriver`, and `descriptor.ts` lists the
  `text` status LED — the generic catalog and `Screen.tsx` do the rest.
- Tests: `tests/c128/c128-ocr.test.ts` (geometry from hand arithmetic on the registers,
  the attribute bits, alternate and inverse glyphs, the two fields, the blanking
  rectangles, the driver), and real-firmware cases in `c128-services.test.ts` (both
  screens' banners, a blanked 80-column cell, and that a 40-column boot leaves the VDC
  empty so the menu's 80 setting shows nothing to read).

Facts found doing it:
- **The 128's power-on screen is not the 64's:** light green (`$0D`) on dark grey (`$0B`),
  measured from the rendered frame, where the 64 is light blue on blue.
- The 40-column field's `borderTop - 3` is the KERNAL's YSCROLL of 3 cancelled, so the
  grid lands on the display window at (32, 35) rather than three lines into it.
- A plain 40-column boot never writes the VDC: it is programmed and cleared (auto shows
  whichever chip the 40/80 key chose at reset), so the overlay legitimately reads nothing
  there.

### Phase 5: C64 mode (`GO64`) *(done, 34d276dc)*
- `$D505` bit 6 and the 64 ROM pair; the MMU then presents the C64's PLA map (reuse the
  PLA rules from `c64/memory.ts` conceptually; the 128 owns its copy). The VIC-IIe's
  extras are masked as the hardware does. 1 MHz forced.
- Re-run the C64 machine's own program/tape/disk scenarios against the 128 in 64 mode
  (the same `.prg`, `.t64`, `.tap`, `.crt` fixtures), plus a "boot with the C= key held"
  case.

**Done:**
- `c128/memory.ts`: with MCR bit 6 set, the map is the 64's PLA, steered by the 8502 port's
  LORAM, HIRAM and CHAREN: 64K of RAM (the block CR names), the 64's BASIC at `$A000`, its
  KERNAL at `$E000`, the character ROM (the first 4K of the 128's) or I/O at `$D000` (either only
  while LORAM or HIRAM is high). The 128's ROMs leave the map, `$FF00-$FF04` are plain memory, page
  0/1 relocation is off, the port's bits 0-2 stop choosing colour RAM banks (bank 0 for both chips),
  and the VIC-II sees the character ROM in banks 0 and 2 only. `loadRoms` takes `basic64` and
  `kernal64` as two more optional images; they are VICE's `basic64` and `kernal64` (8K each).
- `c128-machine.ts`: `$D02F`/`$D030` read `$FF` and ignore writes in 64 mode (the VIC-IIe's extras
  are masked), the keyboard's extra lines are not scanned, Auto shows the VIC-II whatever the 40/80
  key says (`c64Mode` getter).
- **Both ways in work with the real ROMs:** holding C= through the Z80 BIOS's key scan (it writes the
  mode register `$F1`, the 8502 then resets through the 64 map and the 64 KERNAL) boots to
  `**** COMMODORE 64 BASIC V2 ****  64K RAM SYSTEM  38911 BASIC BYTES FREE`; and `GO64` from BASIC 7.0
  (answer `Y` then RETURN, the prompt is a line input) switches on the fly. Typing, `PRINT 6*7`, and
  `POKE`/`PEEK` through the 64K work.
- Tests: `tests/c128/memory.test.ts` (the PLA for all eight port values, writes under ROM, RAM block,
  `$FF00`, no relocation, colour banks, the VIC's character ROM rule) and the machine tests.

Facts found: the Z80 BIOS leaves the MMU at its defaults for a 64 start (CR `$3E`, RCR 0, pointers 0
and 1, preconfigurations cleared), so ignoring relocation in 64 mode loses nothing a normal start
relies on. The VICE source has a thicket of page-0/1 cases for 64 mode (marked as guesses); they
are not copied here.

Not done: cartridges (the PLA takes /GAME and /EXROM as high; Phase 7 owns cartridges), the C64
machine's own PRG/T64/TAP/CRT fixtures against the 128 in 64 mode (they need the media services,
Phase 7), the 1 MHz clock is simply the only clock until Phase 3 adds 2 MHz (which 64 mode must keep
masked), and the 64-mode keyboard's CAPS LOCK / extra keys are only the matrix's.

### Phase 6: drives and fast serial
- 1571 as the default drive (it is the 128's own), 1541 and 1581 selectable, up to four
  as on the 64. Burst-mode reads and writes through CIA 1 SP/CNT and FSDIR, tested with
  the real 1571 and 1581 DOS: `DIRECTORY`, `DLOAD`, `DSAVE`, `HEADER`, `COPY` in BASIC 7.0.
- `.d71` / `.d81` / `.d64` / `.g64` mounting and saving come with the shared drive services.

**Done:**
- `c128-machine.ts`: `iec` (a `CbmSerialBus`) with CIA 2 port A as the 64's bus (ATN, CLK, DATA out
  on bits 3-5, CLK and DATA in on bits 6-7), `drives`, `drive`, `driveModels`, `fitDrives`,
  `installDriveRom` and `installDrive` (the default model is a 1571). The drives are brought up
  to the machine's cycle on CIA 2 port A accesses, on CIA 1's shift register and interrupt
  registers (`$DC0C`, `$DC0D`, `$DC0E`) and at the end of each frame, and start over with the
  machine. CIA 1 is the fast serial port (`attachFastSerial`) and the MMU's mode register bit 3
  is its direction (`onFastSerialDir`).
- `drive-1581.ts`: `fastCia` and `fastTransmitting` (CIA port B bit 5), so the 1581 takes part in
  burst transfers.
- **Verified with the real DOS ROMs** (`tests/c128/c128-drives.test.ts`, skipped without
  `mcp/.cache/dos{1541,1571,1581}.rom` and the 128's under `c128-dev/`): in BASIC 7.0, `DIRECTORY`,
  `DLOAD` + `RUN`, `DSAVE`, `COPY` and `HEADER` on a 1571 (the machine sends its commands and the
  drive its data over the burst bus: hundreds of CNT edges per directory), `DIRECTORY` and
  `DSAVE` on a 1581 (burst too), `DIRECTORY` and `DLOAD` on a 1541 (the ordinary serial bus; the
  KERNAL probes for burst, gets no answer and falls back), and `LOAD "$",8` from C64 mode with the
  1571 acting as a 1541.

Not done: `.g64` and the Drives pane (Phase 7), more than one drive tested on a 128 (the bus
supports four), and the snapshot of a drive's state (Phase 7).

### Phase 7: media, services and UI
- Descriptor, services (`media`, `roms`, `tape`, `disks`, `snapshots`, `debug`, `input`,
  `probe`), registry and `models.ts` entries, the ROM pane sockets (BASIC lo, BASIC hi,
  KERNAL, 64 BASIC, 64 KERNAL, character ROM), the PRG/T64 injection with BASIC 7's
  pointers (text start `$1C01`, and the 64's `$0801` in 64 mode).
- Tape: Datasette on the 8502 port; auto-PLAY as on the 64.
- Cartridges: 64 mode as today, 128 mode as the internal/external function ROM.
- Hardware pane: VDC RAM 16K/64K, SID model, drives, 2 MHz indicator. Status LEDs.
- Snapshots: native `.c128state` with MMU, VDC, both CIAs and the CPU in play.
- BASIC pane: BASIC 7.0 token table and variable layout.
- MCP: `chip_state` gains `mmu` and `vdc`; machine-specific tool only if needed.
- Joystick, 1351 mouse, SID options carry over from the 64. On-screen keyboard with the
  extra keys.

**Done (Phase 7, in the working tree):**
- `models.ts` (`c128`, the six ROM sources and sockets), `descriptor.ts` (the 40-column frame, or
  the VDC's when `showing80`; PAL or NTSC by locale; up to four drives with the 1571 as the
  default), `services/` (`media`, `roms`, `tape`, `disks`, `snapshots`, `debug` = the m6502
  service, `input`, `probe`), `chip-dump.ts` (`chip_state` gains `vdc` and `mmu`; the VIC, SID and CIA
  dumps moved to `shared/cbm/chip-dump.ts` and the 64 uses them too), the registry, model menu
  (Commodore group), Save menu entry, `machine-ui.ts` entry.
- **ROM sockets of two sizes.** The six chips are 16K, 16K, 16K, 8K, 8K, 8K, so a socket is not a
  multiple of one stride: `models.ts` gained `romSlotOffset(model, page)` and
  `romSlotSize(model, page)` and `shell/rom.ts` uses them (every other machine keeps its
  stride). Sources: `c128/basiclo-318018-04.rom`, `basichi-318019-04.rom`, `kernal-318020-05.rom`,
  `chargen-325078-03.rom`, and the 64's `c64/basic-901226-01.rom` and `kernal-901227-03.rom`
  already on the host. **All six are live on R2** (verified 2026-11-14: the md5s match the Phase 0
  table, and the six fetched in `C128_ROM_SOURCES` order concatenate to the 72K
  `d5380c9f2a25f4501f5a1fc34cbaf883`, the image the tests load).
- **Programs**: a `.prg` or `.t64` goes in as on the 64, with BASIC 7.0's pointers ($2D-$34, program
  at $1C01, keyboard queue $034A/$D0) or BASIC V2's. A BASIC program says its mode by its start: $1C01
  stays in C128 mode, $0801 restarts the machine in C64 mode (C= held through the BIOS's read,
  released after 30 frames), as a person would.
- **Datasette** (the 8502 port's bits 3-5, PLAY auto-pressed, turbo, recorder) verified with the real
  KERNAL: `LOAD "B"` from a mounted tape finds and loads it, `SAVE` on the empty deck records pulses.
- **Snapshots** `.c128state` (magic ZX28): CPU, Z80, machine, TV, memory + MMU, VDC, VIC, SID, both
  CIAs, the fast serial shift registers, the drives. A state saved with the other amount of VDC RAM is
  refused with a message. A restored machine runs on bit for bit as the original.
- **Hardware pane**: Display (Auto / 40 / 80), VDC RAM (16K / 64K), the drive. Joysticks, the 1351 mouse
  and the SID model carry over from the 64 (the `c64-sid` setting is shared).
- **Keyboard**: the breadbin keyboard with an extra strip (ESC, TAB, ALT, HELP, LINE FEED, NO SCROLL,
  cursors, keypad, and the latching CAPS LOCK and 40/80 keys). Host keys: F9 = ESC, F10 = HELP,
  right Alt = ALT, Scroll Lock = NO SCROLL, Caps Lock and Pause latch CAPS LOCK and 40/80.
- **MCP**: `type` takes characters as on the 64, `c64drive` and `c64sid` work on a 128.
- Tests: `tests/c128/c128-services.test.ts`; `tests/bare-boot.ts` hands the ROM-less 128 from its Z80
  to the 8502 for the all-machines stop, beam and trace tests.

**Cartridges done:** the expansion port takes a 64 cartridge (the boards of `shared/cbm/cartridge.ts`, seen in
C64 mode; the BIOS starts the machine in C64 mode for one) or a 128 function ROM (`c128/function-rom.ts`:
a `C128 CARTRIDGE` `.crt` or a bare 8K/16K/32K image, mapped by the MMU's external function ROM setting;
the KERNAL autostarts it by its CBM header). One thing on the port at a time. The BASIC 7.0 panes and the
TEXT overlay are done too.

**Z80 debug and trace done:** the debugger follows whichever CPU runs (the Z80 until the BIOS hands over,
then the 8502). Registers, disassembly, poking, step into/over/out and breakpoints are the Z80's while it
is in charge (`Z80DebugService` over a host of the 128's own: the Z80's address space, with the BIOS at
$0000 and I/O only through IN and OUT); `stepInstruction` runs one instruction of either CPU with the
chips clocked and switches the debugger to the 8502 at the step that hands over. Memory and port
watchpoints see the Z80's accesses (its port is the $Dxxx address). One trace (`c128/trace.ts`) spans
both: the Z80 text and the 8502 text under `--- Z80 ---` and `--- 8502 ---` headings in the order they
ran, or one CPU's text bare when only it ran; `zxtl` is the Z80's only. Tests: `tests/c128/c128-debug.test.ts`
(with `hand-bios.ts`, and the real BIOS stepped to the handover). Z80 interrupts are not in the
interrupt log and its accesses are stamped per instruction, not per cycle.

**Banked 128 cartridges done**, for the boards of the VICE manual's C128 list whose registers it describes:
Generic (no banks), Warpspeed128 (the $9E00-$9FFF part mirrored at $DE00-$DFFF), Partner 128 (an 8K RAM
window at $DE00 with 64 blocks picked by $DE80, the ROM's $9E80 part at $DE80) and Magic Desk 128 (16K banks,
low six bits of a write to $DE00). Their I/O 1 and 2 answer in 128 mode. Comal 80 and Gmod2-C128 are
refused by name, since the manual gives no layout for their registers.

**Not done:** the Comal 80 and Gmod2-C128 boards, and the internal function ROM socket's UI.

### Phase 8: Z80 and CP/M *(only if wanted, decision 3)*
- Z80 memory and I/O through the MMU, the Z80 clock/wait-state model, the
  CP/M boot sector check from the BIOS.
- MFM in the 1571 (WD1770 on the 1571's second controller), then a CP/M 3.0 system disk
  boots to `A>`. Debugger routing per decision 5(b).

### Phase 9: documentation and release
- `docs/machines/commodore-128.md` from the template, README machine table and model id,
  `docs/developer-tools.md`, `ChangelogPane` entry. Run the capability test
  (`tests/machine-capabilities.test.ts`); every `descriptor.ui` flag must be kept.
- Upload the ROMs to R2 with your OK, md5-verify, then flip the feature live.

**Done:**
- `docs/machines/commodore-128.md` written from the template: models, the six ROM sockets and
  their two sizes, the built-in hardware (with 2 MHz, interlace and the VDC's block timing called
  out as not modelled), peripherals, media formats, the two-chip display, the TEXT overlay on both
  screens, tools, known issues, what is deliberately left out, and the quirks not to "fix".
- README: the machine table gained the Commodore 128 row (8502 / Z80).
- `docs/developer-tools.md`: the machine-availability table gained the C64, C128 and VIC-20 rows.
- **ROMs:** all six verified live on R2 on 2026-11-14 — the md5s match the Phase 0 table, and the
  six in `C128_ROM_SOURCES` order concatenate to the 72K image the tests load
  (`d5380c9f…b883`). Nothing needed uploading: the files were already there and correct.
- The capability test (`tests/machine-capabilities.test.ts`) passes. Its `SNAPSHOT_FORMAT` map had
  no `snapshot-c128state` entry, so the check that the snapshot service can save that format was
  skipping the 128; the entry is added and was confirmed to fail when the format's extension is
  changed, so the 128's snapshot is now guarded.

**Not done:**
- The `ChangelogPane` entry and the version bump — those are the release step, not the machine.
- **No browser check yet.** Both screens have been verified headlessly and as PNGs written from a
  headless frame; nobody has watched the machine run in a browser.

---

## 5. Risks and unknowns

- **MMU and 2 MHz are the accuracy-critical parts.** The wrong clock rules in fast mode
  show up as slow or fast software, not as a crash; the tests need hardware-documented
  numbers, not our own output.
- **Frame cost.** Two video chips, two displays and a 2 MHz CPU. The VDC only needs to
  render when it is the visible display, which keeps the cost close to the 64's. Measure
  in Phase 3 and 4.
- **Burst mode** depends on the CIA shift-register rework; a mistake there would also
  affect the 64's CIA tests, so that change stays behind the existing `mos6526` suite.
- **Z80 coverage.** Boot needs a handful of instructions; CP/M needs the full core and
  its timing. The core is shared with five other machines, so any change there needs
  those machines' suites green.
- **ROM provenance.** The files are VICE's; confirm revisions (318020-05 KERNAL etc.)
  before hosting.

## 6. Out of scope for the first release

REU/GeoRAM and the 1750/1764 RAM expanders, Commodore 128 printer and RS-232 userport
modems, the 1902/1084 monitor emulation details, the C128's internal function-ROM
sockets as a user feature, and the 2 MHz PAL-specific line-skipping subtleties until
Phase 3 shows they matter.
